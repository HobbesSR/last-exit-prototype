import { count } from './profiler.ts';
import { finite } from './numbers.ts';
import { shapeOf, bounds, nearBounds, rect } from './shape.ts';
import { diskPenetration, prepare, segmentShapeDistance, type Prepared } from './shape-queries.ts';
import type { Bounded, Shape } from './shape.ts';
import type { Box, CollisionMap, Obstacle, Player, PlayerInput, Vec2, World } from './types.ts';
import { hypot } from './math.ts';
import { BUCKET, bucketBox, cellsAlong } from './buckets.ts';
import { gateIndex, gateShape, gatesNear } from './gate-index.ts';
import { insideMap, occupiedCell, playableAreaOf } from './playable-area.ts';
import { obstacleCache, PREPARATION_CHUNK } from './obstacle-cache.ts';
import { seeThrough } from './sight.ts';

// Geometry is described once in `shape.ts` and consumed here. This module owns collision: whether a body
// may occupy a place, the movement sweep and sliding a body. Sight casting is `sight.ts`, where the gates
// are is `gate-index.ts`, and reading the playable area is `playable-area.ts` (#1184).
/** One record resolved to its shape, bounds and prepared query form, all kept for as long as the map lives. */
interface Collider {
  source?: Obstacle;
  shape: Shape;
  box: Box;
  prepared: Prepared;
  kind?: string | undefined;
}
interface Colliders {
  count: number;
  shapes: Collider[];
  /** Obstacle colliders indexed by `BUCKET`-sized cell, keyed `"<col>,<row>"`. */
  buckets: Map<string, Collider[]>;
}

export const TILE = 40; // Distance unit and navigation sampling size, never a movement or rendering grid.
/** Resolve a stored record -- an obstacle, or a closed gate's box -- into a reusable collider. */
function collider(source: Bounded & { kind?: string | undefined }): Collider {
  const shape = shapeOf(source);
  return { shape, box: bounds(shape), prepared: prepare(shape), kind: source.kind };
}
function* buildColliders(obstacles: readonly Obstacle[]): Generator<void, Colliders> {
  const count = obstacles.length, shapes: Collider[] = [];
  let work = 0;
  for (const o of obstacles) {
    shapes.push({ ...collider(o), source: o });
    if (++work % PREPARATION_CHUNK === 0) yield;
  }
  const buckets = new Map<string, Collider[]>();
  for (const entry of shapes) {
    bucketBox(buckets, entry.box, entry);
    if (++work % PREPARATION_CHUNK === 0) yield;
  }
  if (work % PREPARATION_CHUNK !== 0) yield;
  return { count, shapes, buckets };
}
const colliderIndex = obstacleCache(buildColliders);
/** Prepare the collision index ahead of the first query, yielding between bounded batches (see `ObstacleCache`). */
export const prepareMovementGeometry = (map: CollisionMap, yieldControl: () => Promise<void>): Promise<void> => colliderIndex.prepare(map, yieldControl);
function nearbyShapes(map: CollisionMap, x: World, y: World, radius: World): Set<Collider> {
  const found = new Set<Collider>(), { buckets } = colliderIndex.get(map);
  for (let bx = Math.floor((x - radius) / BUCKET); bx <= Math.floor((x + radius) / BUCKET); bx++)
    for (let by = Math.floor((y - radius) / BUCKET); by <= Math.floor((y + radius) / BUCKET); by++)
      for (const shape of buckets.get(`${bx},${by}`) || []) found.add(shape);
  return found;
}
function voidCellsNear(map: CollisionMap, x: number, y: number, reach: number): Box[] {
  const area = map.playableArea!;
  const size = area.cellSize, boxes: Box[] = [];
  const left = Math.max(0, Math.floor((x - reach) / size));
  const right = Math.min(Math.ceil(map.width / size) - 1, Math.floor((x + reach) / size));
  const top = Math.max(0, Math.floor((y - reach) / size));
  const bottom = Math.min(Math.ceil(map.height / size) - 1, Math.floor((y + reach) / size));
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++)
    if (!occupiedCell(area, col, row)) boxes.push({ x: col * size, y: row * size, w: size, h: size });
  return boxes;
}
export function canOccupy(map: CollisionMap, x: World, y: World, radius: World = 12, ignoreGates = false, projectile = false): boolean {
  count('calls.canOccupy');
  if (!insideMap(map, x, y, radius)) return false;
  for (const o of nearbyShapes(map, x, y, radius)) {
    if (projectile && seeThrough(o.kind)) continue;
    if (!nearBounds(o.box, x, y, radius)) continue;
    const hit = diskPenetration(x, y, radius, o.shape, o.prepared);
    if (hit && hit.depth > 0.01) return false;
  }
  if (!ignoreGates) for (const g of gatesNear(map, x - radius, y - radius, x + radius, y + radius)) if (!g.open) {
    const box = gateShape(g);
    if (!nearBounds(box, x, y, radius)) continue;
    const o = collider(box);
    if (diskPenetration(x, y, radius, o.shape, o.prepared)) return false;
  }
  return true;
}
/**
 * Can a disk of `radius` travel the closed segment from `a` to `b`: the swept form of `canOccupy`,
 * so a move between two clear points cannot pass through a wall thinner than the gap between their
 * disks (22.6, "Safety"). Distances are exact, through `segmentShapeDistance`, against obstacles,
 * closed gates and the playable area's void cells, with `canOccupy`'s tolerances: obstacles may
 * overlap by 0.01, gates not at all.
 */
export function sweptClear(map: CollisionMap, a: Vec2, b: Vec2, radius: World): boolean {
  count('calls.sweptClear');
  if (!insideMap(map, a.x, a.y, radius) || !insideMap(map, b.x, b.y, radius)) return false;
  const left = Math.min(a.x, b.x) - radius, right = Math.max(a.x, b.x) + radius;
  const top = Math.min(a.y, b.y) - radius, bottom = Math.max(a.y, b.y) + radius;
  const near = (box: Box) => box.x <= right && box.y <= bottom && box.x + box.w >= left && box.y + box.h >= top;
  const { buckets } = colliderIndex.get(map), seen = new Set<Collider>();
  let blocked = false;
  cellsAlong(a, b, radius, BUCKET, (col, row) => {
    if (blocked) return;
    for (const o of buckets.get(`${col},${row}`) || []) {
      if (seen.has(o)) continue;
      seen.add(o);
      if (near(o.box) && segmentShapeDistance(a, b, o.shape) < radius - 0.01) { blocked = true; return; }
    }
  });
  if (blocked) return false;
  // Only the gates in cells within `radius` of the segment: a gate it passes closer than that to has a
  // point there. The answer is whether any blocks, so the order and repeats do not change it.
  const gates = gateIndex(map);
  cellsAlong(a, b, radius, BUCKET, (col, row) => {
    if (blocked) return;
    for (const i of gates.buckets.get(`${col},${row}`) ?? []) {
      const g = map.gates[i];
      if (g.open) continue;
      // Bounds first, before any allocation: a planner sweeps every move against the gates near it.
      const w = g.w || 26, h = g.h || 54;
      if (g.x - w / 2 > right || g.y - h / 2 > bottom || g.x + w / 2 < left || g.y + h / 2 < top) continue;
      if (segmentShapeDistance(a, b, shapeOf(gateShape(g))) < radius) { blocked = true; return; }
    }
  });
  if (blocked) return false;
  // The playable area is convex only without a mask; a mask's holes are tested as filled cells.
  const area = map.playableArea;
  if (area) {
    const size = area.cellSize;
    cellsAlong(a, b, radius, size, (col, row) => {
      if (!blocked && !occupiedCell(area, col, row) && segmentShapeDistance(a, b, rect(col * size, row * size, size, size)) < radius) blocked = true;
    }, Math.ceil(map.width / size), Math.ceil(map.height / size));
  }
  return !blocked;
}
/** A player's collision radius: what movement slides and what a placed body must fit. */
export const bodyRadius = (p: Pick<Player, 'role'>): World => p.role === 'gladiator' ? 23 : 12;
/** Movement distance in world units per legacy tick. Scale the base before modifiers to retain
 * the existing floating-point order when a caller needs units per second. */
export function movementSpeed(p: Pick<Player, 'role' | 'boost' | 'stun'>, input: Pick<PlayerInput, 'sneak'>, unitScale = 1): World {
  let speed = (p.role === 'contestant' ? 9 : 8) * unitScale;
  if (p.boost) speed *= p.role === 'contestant' ? 1.45 : 1.5;
  if (p.stun) speed *= 0.35;
  if (input.sneak && p.role === 'contestant') speed *= 0.55;
  return speed;
}

/** Shared disk sliding for tools and actors with explicit body dimensions. Input is normalized here. */
export function moveBody<T extends Vec2>(map: CollisionMap, p: T, input: { x?: number | undefined; y?: number | undefined }, radius: number, speed: number): T {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(speed) || speed < 0) throw new Error('Invalid movement dimensions.');
  // Small steps prevent a fast body from crossing a void cell and landing on the far side.
  const area = playableAreaOf(map);
  if (speed > area.cellSize / 2) {
    const steps = Math.ceil(speed / (area.cellSize / 2));
    for (let i = 0; i < steps; i++) moveBody(map, p, input, radius, speed / steps);
    return p;
  }
  const x = finite(input.x) ? input.x : 0, y = finite(input.y) ? input.y : 0;
  const norm = Math.max(1, hypot(x, y));
  let cx = p.x + x / norm * speed, cy = p.y + y / norm * speed;
  const colliders: Collider[] = [...nearbyShapes(map, cx, cy, radius + speed)].filter(o => nearBounds(o.box, cx, cy, radius + speed));
  const reach = radius + speed;
  for (const g of gatesNear(map, cx - reach, cy - reach, cx + reach, cy + reach)) if (!g.open) {
    const box = gateShape(g);
    if (nearBounds(box, cx, cy, reach)) colliders.push(collider(box));
  }
  for (const box of voidCellsNear(map, cx, cy, radius + speed)) colliders.push(collider(box));
  // Separating the disk from each collider in turn slides it along walls and around obstacle corners.
  for (let pass = 0; pass < 3; pass++) for (const o of colliders) {
    const hit = diskPenetration(cx, cy, radius, o.shape, o.prepared);
    if (hit) { cx += hit.x; cy += hit.y; }
  }
  cx = Math.max(radius, Math.min(map.width - radius, cx));
  cy = Math.max(radius, Math.min(map.height - radius, cy));
  // A deep-void start has no well-defined escape direction. Keep the last valid placement.
  if (!insideMap(map, cx, cy, radius)) { cx = p.x; cy = p.y; }
  p.x = Math.round(cx * 1000) / 1000; p.y = Math.round(cy * 1000) / 1000;
  return p;
}
