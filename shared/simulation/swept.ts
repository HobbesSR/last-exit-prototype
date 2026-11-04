import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { bounds, circle, polygon, rect, segmentShapeDistance } from '../shape.ts';
import type { Shape } from '../shape.ts';
import { seeThrough } from '../movement.ts';
import type { BodyDefinition } from '../physics/types.ts';
import { bodyShape } from '../physics/presentation-geometry.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { Box, CollisionMap, Game, Gate, Role, Vec2 } from '../types.ts';

// The one owner of swept queries against actors and geometry: physical projectiles and the P6 hook
// tip/tether both ask the same questions, differing only in radius and which geometry blocks them.

const BISECTION_STEPS = 26;
/** Bucket side for the static and gate indexes, in world units; the same scale as movement's buckets. */
const BUCKET = 200;

/**
 * Shapes bucketed by their bounds, so a sweep reads only the shapes in the cells its box covers. `boxes[i]`
 * is `bounds(shapes[i])`, computed once. Buckets hold indices into `shapes`, so candidates can be put back in
 * list order: `firstContact` brackets each shape's bisection by the contact found before it, so its result
 * depends, in the last bits, on the order shapes are met.
 */
interface ShapeIndex { shapes: Shape[]; boxes: Box[]; buckets: Map<string, number[]>; marks: Uint32Array; mark: number }
const shotCache = new WeakMap<CollisionMap, ShapeIndex>();
const solidCache = new WeakMap<CollisionMap, ShapeIndex>();
// A gate's box never moves; only `open` changes. Keyed by the gate list, as movement's gate index is: a list may
// grow but is never reordered in place, so the count tells whether it has.
interface GateShapes { count: number; index: ShapeIndex }
const gateCache = new WeakMap<readonly Gate[], GateShapes>();

function shapeIndex(shapes: Shape[]): ShapeIndex {
  const boxes = shapes.map(bounds), buckets = new Map<string, number[]>();
  boxes.forEach((box, i) => {
    for (let x = Math.floor(box.x / BUCKET); x <= Math.floor((box.x + box.w) / BUCKET); x++)
      for (let y = Math.floor(box.y / BUCKET); y <= Math.floor((box.y + box.h) / BUCKET); y++) {
        const key = `${x},${y}`, list = buckets.get(key);
        if (list) list.push(i); else buckets.set(key, [i]);
      }
  });
  return { shapes, boxes, buckets, marks: new Uint32Array(shapes.length), mark: 0 };
}

/**
 * Indices of the shapes whose bounds meet the box, ascending. Every shape `firstContact` would not skip by its
 * box test is here: a shared point lies in a cell both cover. Shapes in several cells are met once.
 */
function candidates(index: ShapeIndex, left: number, top: number, right: number, bottom: number): number[] {
  const found: number[] = [];
  if (++index.mark === 0xffffffff) { index.marks.fill(0); index.mark = 1; }
  for (let x = Math.floor(left / BUCKET); x <= Math.floor(right / BUCKET); x++)
    for (let y = Math.floor(top / BUCKET); y <= Math.floor(bottom / BUCKET); y++) {
      for (const i of index.buckets.get(`${x},${y}`) ?? []) {
        if (index.marks[i] === index.mark) continue;
        index.marks[i] = index.mark;
        const box = index.boxes[i]!;
        if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) continue;
        found.push(i);
      }
    }
  return found.sort((a, b) => a - b);
}

/** Swept hit radius of an actor, shared by shots, the hook tip and legacy projectiles. */
export function actorHitRadius(role: Role): number { return role === 'gladiator' ? 26 : 15; }

export function shapeOfBody(body: BodyDefinition): Shape {
  if (body.shape.kind === 'circle') return circle(body.x, body.y, body.shape.radius);
  if (body.shape.kind === 'box') return rect(body.x - body.shape.hx, body.y - body.shape.hy,
    body.shape.hx * 2, body.shape.hy * 2);
  return polygon(body.x, body.y, body.shape.vertices);
}

function staticIndex(map: CollisionMap, passSeeThrough: boolean): ShapeIndex {
  const cache = passSeeThrough ? shotCache : solidCache;
  let cached = cache.get(map);
  if (!cached) {
    const passable = passSeeThrough
      ? new Set(map.obstacles.filter(o => seeThrough(o.kind)).map(o => `obstacle:${o.id}`)) : new Set<string>();
    cached = shapeIndex(buildPhysicsGeometry(map).filter(body => !passable.has(body.id)).map(shapeOfBody));
    cache.set(map, cached);
  }
  return cached;
}

/**
 * Static physics geometry as query shapes. Shots pass see-through obstacles (fences, windows); a
 * tether is physical and does not, so `passSeeThrough` is the caller's stated policy.
 */
export function staticShapes(map: CollisionMap, passSeeThrough: boolean): Shape[] {
  return staticIndex(map, passSeeThrough).shapes;
}

/** Every gate's closed shape, open or not, indexed by position in the list. */
function gateIndex(gates: readonly Gate[]): ShapeIndex {
  let cached = gateCache.get(gates);
  if (cached?.count !== gates.length) gateCache.set(gates, cached = { count: gates.length, index: shapeIndex(gates.map(gate => shapeOfBody(physicsGate(gate)))) });
  return cached.index;
}

/** The closed gates' shapes in list order, borrowed from the gate index: read-only. */
export function closedGateShapes(gates: readonly Gate[]): Shape[] {
  const { shapes } = gateIndex(gates);
  return shapes.filter((_, i) => !gates[i]!.open);
}

/**
 * First contact of a sweep with the map's blocking geometry: its static shapes under `passSeeThrough`'s policy,
 * then its closed gates, then `extra`. The same answer, to the bit, as `firstContact` over that whole list, but
 * it reads only the shapes in the cells the sweep's box covers, kept in list order (#668).
 */
export function geometryContact(map: CollisionMap, passSeeThrough: boolean, a: Vec2, b: Vec2, radius: number, extra: readonly Shape[] = []): number {
  const left = Math.min(a.x, b.x) - radius, right = Math.max(a.x, b.x) + radius;
  const top = Math.min(a.y, b.y) - radius, bottom = Math.max(a.y, b.y) + radius;
  const statics = staticIndex(map, passSeeThrough), gates = gateIndex(map.gates), shapes: Shape[] = [];
  for (const i of candidates(statics, left, top, right, bottom)) shapes.push(statics.shapes[i]!);
  for (const i of candidates(gates, left, top, right, bottom)) if (!map.gates[i]!.open) shapes.push(gates.shapes[i]!);
  for (const shape of extra) shapes.push(shape);
  return firstContact(a, b, shapes, radius);
}

/** Solid props in the physics world (not loot), as query shapes. */
function solidProps(game: Game): Shape[] {
  const props = physicsRuntime(game)?.world.snapshot({ includeStatic: false }).bodies
    .filter(body => body.spec.kind === 'prop' && body.spec.collisionProfile !== 'loot') ?? [];
  // Specs, including an unrotated convex body's vertices, are frozen: shared with the world, never edited.
  return props.map(({ spec, transform }) => bodyShape({ ...transform, shape: spec.shape }));
}

/** Current solid query geometry for the physical hook and diagnostic casts.
 * Static descriptors are borrowed from the map cache; callers must treat all returned shapes as read-only.
 */
export function solidBlockers(game: Game): Shape[] {
  return [...staticShapes(game.map, false), ...closedGateShapes(game.map.gates), ...solidProps(game)];
}

/** First contact of a sweep with `solidBlockers`, read through the indexes. */
export function solidContact(game: Game, a: Vec2, b: Vec2, radius: number): number {
  return geometryContact(game.map, false, a, b, radius, solidProps(game));
}
/** First relative disk intersection of a moving point and a moving actor, including an initial overlap. */
export function impact(a: Vec2, b: Vec2, start: Vec2, end: Vec2, radius: number): number | null {
  const x = a.x - start.x, y = a.y - start.y;
  const dx = b.x - a.x - (end.x - start.x), dy = b.y - a.y - (end.y - start.y);
  const c = x * x + y * y - radius * radius;
  if (c <= 0) return 0;
  const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), d = bb * bb - 4 * aa * c;
  if (!aa || d < 0) return null;
  const t = (-bb - Math.sqrt(d)) / (2 * aa);
  return t >= 0 && t <= 1 ? t : null;
}

/** First contact of a radius-`radius` point swept from a to b with any shape; Infinity when clear. */
export function firstContact(a: Vec2, b: Vec2, shapes: readonly Shape[], radius: number): number {
  const left = Math.min(a.x, b.x) - radius;
  const right = Math.max(a.x, b.x) + radius;
  const top = Math.min(a.y, b.y) - radius;
  const bottom = Math.max(a.y, b.y) + radius;
  let first = Infinity;
  for (const shape of shapes) {
    const box = bounds(shape);
    if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) continue;
    if (segmentShapeDistance(a, b, shape) > radius) continue;
    if (segmentShapeDistance(a, a, shape) <= radius) return 0;
    let lo = 0, hi = first < Infinity ? first : 1;
    // A prior collider may already be earlier than this one.
    const clipped = { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi };
    if (segmentShapeDistance(a, clipped, shape) > radius) continue;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2;
      const end = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
      if (segmentShapeDistance(a, end, shape) <= radius) hi = mid;
      else lo = mid;
    }
    // The lower bracket is conservatively before contact, so a mathematically
    // simultaneous actor and wall hit is awarded to geometry despite rounding.
    first = Math.min(first, lo);
  }
  return first;
}
