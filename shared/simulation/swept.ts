import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { bounds, circle, polygon, rect } from '../shape.ts';
import { segmentShapeDistance } from '../shape-queries.ts';
import type { Shape } from '../shape.ts';
import { seeThrough } from '../sight.ts';
import { bucketBox, eachCellIn, Visited } from '../buckets.ts';
import type { BodyDefinition } from '../physics/types.ts';
import { bodyShape } from '../physics/presentation-geometry.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { Box, CollisionMap, Game, Gate, Vec2 } from '../types.ts';

// Swept queries against actors and geometry: physical projectiles and the hook tip/tether ask the same questions,
// differing only in radius and which geometry blocks them. Both ask the core's port (`rust/core/src/swept.rs`; the hook
// since #1229, projectiles since #1242), uploaded from these caches (`sweptUpload`). The TypeScript queries below have no
// caller in the game: they stay as `tests/swept-core.test.js`'s reference, which holds the core equal to them to the
// bit, as 5c.1 kept the placement search (27, step 5d.2).

const BISECTION_STEPS = 26;

/**
 * Shapes in the shared static grid (`buckets.ts`), so a sweep reads only the shapes in the cells its box covers.
 * `boxes[i]` is `bounds(shapes[i])`, computed once. Buckets hold indices into `shapes`, so candidates can be put
 * back in list order: `firstContact` brackets each shape's bisection by the contact found before it, so its
 * result depends, in the last bits, on the order shapes are met.
 */
interface ShapeIndex { shapes: Shape[]; boxes: Box[]; buckets: Map<string, number[]> }
const shotCache = new WeakMap<CollisionMap, ShapeIndex>();
const solidCache = new WeakMap<CollisionMap, ShapeIndex>();
// A gate's box never moves; only `open` changes. Keyed by the gate list, as movement's gate index is: a list may
// grow but is never reordered in place, so the count tells whether it has.
interface GateShapes { count: number; index: ShapeIndex }
const gateCache = new WeakMap<readonly Gate[], GateShapes>();
const visited = new Visited();

function shapeIndex(shapes: Shape[]): ShapeIndex {
  const boxes = shapes.map(bounds), buckets = new Map<string, number[]>();
  boxes.forEach((box, i) => bucketBox(buckets, box, i));
  return { shapes, boxes, buckets };
}

/**
 * Indices of the shapes whose bounds meet the box, ascending. Every shape `firstContact` would not skip by its
 * box test is here: a shared point lies in a cell both cover. Shapes in several cells are met once.
 */
function candidates(index: ShapeIndex, left: number, top: number, right: number, bottom: number): number[] {
  const found: number[] = [];
  visited.begin(index.shapes.length);
  eachCellIn(index.buckets, left, top, right, bottom, list => {
    for (const i of list) {
      if (!visited.first(i)) continue;
      const box = index.boxes[i]!;
      if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) continue;
      found.push(i);
    }
  });
  return found.sort((a, b) => a - b);
}

function shapeOfBody(body: BodyDefinition): Shape {
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

/** Prepare both sweep policies on the private match map, using physics geometry in source order.
 * Publish only complete indexes; synchronous callers retain the lazy construction path. */
export async function prepareSweptGeometry(map: CollisionMap, geometry: readonly BodyDefinition[], yieldControl: () => Promise<void>): Promise<void> {
  const shots: ShapeIndex = { shapes: [], boxes: [], buckets: new Map() };
  const solids: ShapeIndex = { shapes: [], boxes: [], buckets: new Map() };
  const passable = new Set<string>();
  for (let i = 0; i < map.obstacles.length; i++) {
    const obstacle = map.obstacles[i]!;
    if (seeThrough(obstacle.kind)) passable.add(`obstacle:${obstacle.id}`);
    if (i % 128 === 127) await yieldControl();
  }
  for (let i = 0; i < geometry.length; i++) {
    const body = geometry[i]!, shape = shapeOfBody(body), box = bounds(shape);
    for (const index of passable.has(body.id) ? [solids] : [solids, shots]) {
      bucketBox(index.buckets, box, index.shapes.length);
      index.shapes.push(shape); index.boxes.push(box);
    }
    if (i % 128 === 127) await yieldControl();
  }
  shotCache.set(map, shots);
  solidCache.set(map, solids);
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

/**
 * What the Rust core's sweep map is uploaded from (`rust/core/src/swept.rs`, #1229): the solid static shapes in
 * order, borrowed from this module's cache so the core sweeps the very shapes `geometryContact` does, each with
 * whether shots also see it (false for a see-through obstacle), and every gate's closed shape in list order.
 * Read-only. `buildPhysicsGeometry` lists the obstacles first, in list order, so shape `i` below the obstacle count is
 * obstacle `i`; the boundary walls and voids after them block shots too.
 */
export function sweptUpload(map: CollisionMap): { statics: readonly Shape[]; shots: boolean[]; gates: readonly Shape[] } {
  const statics = staticIndex(map, false).shapes, obstacles = map.obstacles;
  return { statics, shots: statics.map((_, i) => i >= obstacles.length || !seeThrough(obstacles[i]!.kind)), gates: gateIndex(map.gates).shapes };
}

/** Build complete gate sweep buckets while the match is private. */
export async function prepareSweptGates(gates: readonly Gate[], yieldControl: () => Promise<void>): Promise<void> {
  const index: ShapeIndex = { shapes: [], boxes: [], buckets: new Map() };
  for (let i = 0; i < gates.length; i++) {
    const shape = shapeOfBody(physicsGate(gates[i]!)), box = bounds(shape);
    bucketBox(index.buckets, box, index.shapes.length);
    index.shapes.push(shape); index.boxes.push(box);
    if (i % 128 === 127) await yieldControl();
  }
  gateCache.set(gates, { count: gates.length, index });
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

/**
 * The whole solid query geometry as one list, for diagnostic casts and tests; `solidContact` reads the
 * same geometry through the indexes. Static descriptors are borrowed from the map cache;
 * callers must treat all returned shapes as read-only.
 */
export function solidBlockers(game: Game): Shape[] {
  return [...staticShapes(game.map, false), ...closedGateShapes(game.map.gates), ...solidProps(game)];
}

/** First contact of a sweep with `solidBlockers`, read through the indexes. The hook asks the core's (`hooks.rs`); this
 * is the parity test's reference (`tests/swept-core.test.js`). */
export function solidContact(game: Game, a: Vec2, b: Vec2, radius: number): number {
  return geometryContact(game.map, false, a, b, radius, solidProps(game));
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
