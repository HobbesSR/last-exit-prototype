import { gateShape } from '../movement.ts';
import { convex, shapeOf } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { CollisionMap, Gate, Vec2 } from '../types.ts';
import type { BodyDefinition } from '../physics/types.ts';

/**
 * The largest map side physics accepts, in world units: a precision bound, not a content one. Rapier keeps f32
 * positions, whose spacing grows with distance from the origin; at this extent the jelly still settles within its
 * gates (tests/physics-jelly.test.js), and its settled error doubles with each further doubling (42.22). A larger
 * map would need the world recentred, not a larger number here.
 */
export const MAX_PHYSICS_EXTENT = 2 ** 18;
const MAX_BODIES = 100000;
// The mask build walks rows and each row's runs, never columns, so rows are what it bounds.
const MAX_MASK_ROWS = 2 ** 16;
const MAX_VERTICES = 64;
const WALL = 40;

const valid = (n: number): boolean => Number.isFinite(n);
const positive = (n: number): boolean => valid(n) && n > 0;
const box = (id: string, x: number, y: number, w: number, h: number): BodyDefinition => {
  if (![x, y, w, h].every(valid) || w <= 0 || h <= 0) throw new RangeError(`Invalid physics box ${id}`);
  return { id, kind: 'static', x: x + w / 2, y: y + h / 2, shape: { kind: 'box', hx: w / 2, hy: h / 2 } };
};

function descriptor(id: string, shape: Shape): BodyDefinition {
  if (!valid(shape.x) || !valid(shape.y)) throw new RangeError(`Invalid physics position ${id}`);
  if (shape.kind === 'circle') {
    if (!positive(shape.r)) throw new RangeError(`Invalid physics circle ${id}`);
    return { id, kind: 'static', x: shape.x, y: shape.y, shape: { kind: 'circle', radius: shape.r } };
  }
  if (shape.kind === 'rect') return box(id, shape.x, shape.y, shape.w, shape.h);
  if (shape.points.length < 3 || shape.points.length > MAX_VERTICES ||
    !shape.points.every(p => valid(p.x) && valid(p.y)) || !strictConvex(shape.points)) {
    throw new RangeError(`Invalid physics polygon ${id}`);
  }
  return centeredPolygon(id, shape.x, shape.y, shape.points);
}

function strictConvex(points: Vec2[]): boolean {
  if (!convex(points)) return false;
  let winding = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(turn) <= 1e-8 || (winding && Math.sign(turn) !== winding)) return false;
    winding = Math.sign(turn);
  }
  return true;
}

function centeredPolygon(id: string, x: number, y: number, points: Vec2[]): BodyDefinition {
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return { id, kind: 'static', x: x + meanX, y: y + meanY,
    shape: { kind: 'convex', vertices: points.map(p => ({ x: p.x - meanX, y: p.y - meanY })) } };
}

/** A closed gate uses the same centre and fallback dimensions as legacy movement. */
export function physicsGate(gate: Gate): BodyDefinition {
  return descriptor(`gate:${gate.id}`, shapeOf(gateShape(gate)));
}

/** Build immutable-in-practice, engine-free static footprints for one map revision. Gates are separate. */
export function buildPhysicsGeometry(map: CollisionMap): BodyDefinition[] {
  const { width, height } = map;
  if (!positive(width) || !positive(height) || width > MAX_PHYSICS_EXTENT || height > MAX_PHYSICS_EXTENT) {
    throw new RangeError('Invalid physics map extent');
  }
  const result: BodyDefinition[] = [];
  const add = (entry: BodyDefinition): void => {
    if (result.length === MAX_BODIES) throw new RangeError('Physics static body capacity exceeded');
    result.push(entry);
  };
  const ids = new Set<string>();
  for (const obstacle of map.obstacles) {
    const id = obstacle.id;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new RangeError('Invalid or duplicate physics obstacle ID');
    ids.add(id);
    // Explicitly reject malformed optional forms; shapeOf otherwise falls back to a box.
    if ((obstacle.r !== undefined && !positive(obstacle.r)) ||
      (obstacle.points !== undefined && !obstacle.points.length)) throw new RangeError(`Invalid physics obstacle ${id}`);
    add(descriptor(`obstacle:${id}`, shapeOf(obstacle)));
  }

  // Actual outer contact surfaces sit at x=0/width and y=0/height.
  add(box('boundary:left', -WALL, -WALL, WALL, height + 2 * WALL));
  add(box('boundary:right', width, -WALL, WALL, height + 2 * WALL));
  add(box('boundary:top', 0, -WALL, width, WALL));
  add(box('boundary:bottom', 0, height, width, WALL));

  const area = map.playableArea;
  if (area) {
    const size = area.cellSize;
    if (!positive(size)) throw new RangeError('Invalid physics mask cell size');
    const cols = Math.ceil(width / size), rows = Math.ceil(height / size);
    if (rows > MAX_MASK_ROWS) throw new RangeError('Physics mask grid capacity exceeded');
    // Merge equal void intervals in adjacent rows. This bounds a long straight void
    // edge to one collider and never builds a collider for every empty cell.
    type Gap = { left: number; right: number; first: number; last: number };
    let active = new Map<string, Gap>();
    const emit = (gap: Gap): void => {
      const x = gap.left * size, y = gap.first * size;
      add(box(`void:${gap.first}:${gap.left}:${gap.right}`, x, y,
        Math.min(width, gap.right * size) - x, Math.min(height, (gap.last + 1) * size) - y));
    };
    let cursor = 0;
    for (let row = 0; row < rows; row++) {
      const entry = area.rows[cursor];
      const runs = entry?.y === row ? entry.runs : [];
      if (entry && entry.y < row) throw new RangeError('Physics mask rows must be ordered and unique');
      if (entry?.y === row) cursor++;
      const gaps: Array<[number, number]> = [];
      let col = 0;
      for (const [left, right] of runs) {
        if (!Number.isInteger(left) || !Number.isInteger(right) || left < col || right <= left || right > cols) {
          throw new RangeError('Invalid physics mask run');
        }
        if (left > col) gaps.push([col, left]);
        col = right;
      }
      if (col < cols) gaps.push([col, cols]);
      const next = new Map<string, Gap>();
      for (const [left, right] of gaps) {
        const key = `${left}:${right}`;
        const prior = active.get(key);
        next.set(key, prior ? { ...prior, last: row } : { left, right, first: row, last: row });
      }
      for (const [key, gap] of active) if (!next.has(key)) emit(gap);
      active = next;
    }
    if (cursor !== area.rows.length) throw new RangeError('Physics mask row exceeds map');
    for (const gap of active.values()) emit(gap);
  } else {
    // Legacy playable area is an inset diamond. Four corner triangles fill its
    // outside half-planes up to the rectangular outer boundary.
    const cx = width / 2, cy = height / 2, hx = cx - WALL, hy = cy - WALL;
    if (hx <= 0 || hy <= 0) throw new RangeError('Legacy diamond map is too small');
    const xTop = cx + hx * (cy / hy - 1);
    const ySide = cy + hy * (cx / hx - 1);
    const corners: Array<[string, Vec2[]]> = [
      ['nw', [{ x: 0, y: 0 }, { x: xTop, y: 0 }, { x: 0, y: ySide }]],
      ['ne', [{ x: width, y: 0 }, { x: width, y: ySide }, { x: width - xTop, y: 0 }]],
      ['se', [{ x: width, y: height }, { x: width - xTop, y: height }, { x: width, y: height - ySide }]],
      ['sw', [{ x: 0, y: height }, { x: 0, y: height - ySide }, { x: xTop, y: height }]],
    ];
    for (const [name, vertices] of corners) {
      if (!strictConvex(vertices)) throw new RangeError('Invalid legacy diamond geometry');
      add(centeredPolygon(`boundary:diamond:${name}`, 0, 0, vertices));
    }
  }
  return result;
}
