import SAT from 'sat';
import type { Circle, Polygon } from 'sat';
import { count } from './profiler.ts';
import { finite } from './numbers.ts';
import { shapeOf, bounds, nearBounds, edgesOf, body, separate, segmentShapeDistance, rect } from './shape.ts';
import type { Bounded, Edge, Shape } from './shape.ts';
import type { Box, CollisionMap, Gate, GateId, Obstacle, PlayableArea, Player, PlayerInput, Vec2, World } from './types.ts';
import { atan2, cos, hypot, sin } from './math.ts';
import { BUCKET, bucketBox, eachCellIn, Visited } from './buckets.ts';

// Geometry is described once in `shape.ts` and consumed here. This module owns what the simulation
// does with a shape -- occupancy, the movement sweep and sight -- not what a shape is.
/**
 * Whether sight and shots pass an obstacle of this kind while bodies and hands do not (29): a
 * window, a low pipe run or a hedge, which the game, being 2D, treats the same way (17.2.8 M34).
 */
export const seeThrough = (kind: string | undefined): boolean => kind === 'window' || kind === 'pipe' || kind === 'hedge';
/** One record resolved to its shape, bounds and SAT body, all kept for as long as the map lives. */
interface Collider {
  source?: Obstacle;
  shape: Shape;
  box: Box;
  body: Circle | Polygon;
  kind?: string | undefined;
}
interface Geometry {
  count: number;
  shapes: Collider[];
  /** Obstacle colliders indexed by `BUCKET`-sized cell, keyed `"<col>,<row>"`. */
  buckets: Map<string, Collider[]>;
  segments: Edge[];
  /** Indices into `segments`, bucketed like `buckets`, each under every cell its bounds touch. */
  sight: Map<string, number[]>;
}
/** A visibility polygon vertex, which keeps the ray angle that produced it. */
export interface VisibilityPoint extends Vec2 {
  angle: number;
  length: World;
}

export const TILE = 40; // Navigation sampling only, never a movement or rendering grid.
export const VISION = 620;
// Keyed by the obstacle list, not the map: maps that differ only in gates, such as a contestant's remembered doors
// (simulation/dynamic-navigation.ts), share one geometry instead of rebuilding every collider (#727).
const shapeCache = new WeakMap<readonly Obstacle[], Geometry>();
const playableRows = new WeakMap<PlayableArea, Map<number, Array<[number, number]>>>();
const vec = (x: World, y: World) => new SAT.Vector(x, y);
/** Resolve a stored record -- an obstacle, or a closed gate's box -- into a reusable collider. */
function collider(source: Bounded & { kind?: string | undefined }): Collider {
  const shape = shapeOf(source);
  return { shape, box: bounds(shape), body: body(shape), kind: source.kind };
}
// Count work rather than reading a clock: this path also runs in the portable simulation.
const GEOMETRY_CHUNK = 128;
function* buildGeometry(obstacles: readonly Obstacle[]): Generator<void, Geometry> {
  const count = obstacles.length, shapes: Collider[] = [];
  let work = 0;
  for (const o of obstacles) {
    shapes.push({ ...collider(o), source: o });
    if (++work % GEOMETRY_CHUNK === 0) yield;
  }
  const buckets = new Map<string, Collider[]>();
  for (const entry of shapes) {
    bucketBox(buckets, entry.box, entry);
    if (++work % GEOMETRY_CHUNK === 0) yield;
  }
  const segments: Edge[] = [], sight = new Map<string, number[]>();
  for (const entry of shapes) if (!seeThrough(entry.kind)) for (const edge of edgesOf(entry.shape)) {
    const i = segments.length;
    segments.push(edge);
    bucketBox(sight, edgeBox(edge), i);
    if (++work % GEOMETRY_CHUNK === 0) yield;
  }
  if (work % GEOMETRY_CHUNK !== 0) yield;
  return { count, shapes, buckets, segments, sight };
}
function geometry(map: CollisionMap): Geometry {
  const cached = shapeCache.get(map.obstacles);
  if (cached && cached.count === map.obstacles.length) return cached;
  const build = buildGeometry(map.obstacles);
  let next = build.next();
  while (!next.done) next = build.next();
  shapeCache.set(map.obstacles, next.value);
  return next.value;
}
/** Prepare the same cache queries build on demand, yielding between bounded batches. Only a
 * complete build is published; a query or another preparation may safely finish its own meanwhile.
 * A rejected callback leaves no partial cache. Obstacle-list replacement/growth during a yield
 * restarts preparation with the current list, preserving the synchronous cache's identity/length key. */
export async function prepareMovementGeometry(map: CollisionMap, yieldControl: () => Promise<void>): Promise<void> {
  for (;;) {
    const obstacles = map.obstacles, cached = shapeCache.get(obstacles);
    if (cached && cached.count === obstacles.length) return;
    const build = buildGeometry(obstacles), count = obstacles.length;
    let next = build.next();
    while (!next.done) {
      await yieldControl();
      if (map.obstacles !== obstacles || obstacles.length !== count) break;
      next = build.next();
    }
    if (!next.done) continue;
    shapeCache.set(obstacles, next.value);
    return;
  }
}
const edgeBox = (edge: Edge): Box => {
  const x = Math.min(edge.a.x, edge.b.x), y = Math.min(edge.a.y, edge.b.y);
  return { x, y, w: Math.max(edge.a.x, edge.b.x) - x, h: Math.max(edge.a.y, edge.b.y) - y };
};
// Gates indexed by their boxes, which never move, with each box's sight edges; whether one is open is read
// when it is met. Buckets hold indices into `map.gates`, so a query can return its gates in map order. A gate
// list may grow, but is never reordered in place: a different order is a different array. Edges are built
// on first use, since a contestant's local map (dynamic-navigation.ts) copies the gate list when a door changes.
interface GateIndex { count: number; buckets: Map<string, number[]>; edges: (Edge[] | undefined)[] }
const gateCache = new WeakMap<Gate[], GateIndex>();
function gateIndex(map: CollisionMap): GateIndex {
  let cached = gateCache.get(map.gates);
  if (cached?.count !== map.gates.length) {
    const buckets = new Map<string, number[]>();
    map.gates.forEach((g, i) => bucketBox(buckets, gateShape(g), i));
    gateCache.set(map.gates, cached = { count: map.gates.length, buckets, edges: [] });
  }
  return cached;
}
const gateEdges = (map: CollisionMap, gates: GateIndex, i: number): Edge[] => gates.edges[i] ??= edgesOf(shapeOf(gateShape(map.gates[i])));
const visitedGates = new Visited(), visitedEdges = new Visited();
/**
 * The gates, open or closed, whose boxes may touch the closed box from `left`,`top` to `right`,`bottom`,
 * in map order and each once. It may also return gates near the box; the caller makes its exact test.
 */
export function gatesNear(map: CollisionMap, left: World, top: World, right: World, bottom: World): Gate[] {
  const found: number[] = [];
  visitedGates.begin(map.gates.length);
  eachCellIn(gateIndex(map).buckets, left, top, right, bottom, list => { for (const i of list) if (visitedGates.first(i)) found.push(i); });
  return found.sort((a, b) => a - b).map(i => map.gates[i]);
}
/**
 * Visit, until `visit` returns true, what the buckets hold in every cell within SIGHT_PAD of segment `ab`.
 * A segment meets an edge at a point inside both, so the edge is listed in a visited cell; the pad covers
 * rounding at cell borders. An entry listed in several cells may be visited more than once.
 */
const SIGHT_PAD = 1;
function someAlong<T>(buckets: Map<string, T[]>, a: Vec2, b: Vec2, visit: (entry: T) => boolean): boolean {
  let found = false;
  cellsAlong(a, b, SIGHT_PAD, BUCKET, (col, row) => {
    if (found) return;
    for (const entry of buckets.get(`${col},${row}`) ?? []) if (visit(entry)) { found = true; return; }
  });
  return found;
}
function nearbyShapes(map: CollisionMap, x: World, y: World, radius: World): Set<Collider> {
  const found = new Set<Collider>(), { buckets } = geometry(map);
  for (let bx = Math.floor((x - radius) / BUCKET); bx <= Math.floor((x + radius) / BUCKET); bx++)
    for (let by = Math.floor((y - radius) / BUCKET); by <= Math.floor((y + radius) / BUCKET); by++)
      for (const shape of buckets.get(`${bx},${by}`) || []) found.add(shape);
  return found;
}
export function gateShape(g: Bounded): Box { const w = g.w || 26, h = g.h || 54; return { x: g.x - w / 2, y: g.y - h / 2, w, h }; }
function occupiedCell(area: PlayableArea, col: number, row: number): boolean {
  let rows = playableRows.get(area);
  if (!rows) { rows = new Map(area.rows.map(entry => [entry.y, entry.runs])); playableRows.set(area, rows); }
  const runs = rows.get(row);
  if (!runs) return false;
  // Runs are ordered and disjoint in the map contract.
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid][1] <= col) lo = mid + 1; else hi = mid;
  }
  return lo < runs.length && runs[lo][0] <= col;
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
/**
 * Each cell of a `size` grid within `radius` of segment `ab`: row by row, only the columns the
 * segment's band crosses, so a long diagonal costs its length rather than its bounding square.
 * With `cols` and `rows`, cells are clamped to that grid; without, indices may be negative.
 */
function cellsAlong(a: Vec2, b: Vec2, radius: number, size: number, visit: (col: number, row: number) => void, cols?: number, rows?: number): void {
  const low = cols === undefined ? -Infinity : 0;
  const top = Math.max(low, Math.floor((Math.min(a.y, b.y) - radius) / size));
  const bottom = Math.min((rows ?? Infinity) - 1, Math.floor((Math.max(a.y, b.y) + radius) / size));
  const dy = b.y - a.y;
  for (let row = top; row <= bottom; row++) {
    // The part of the segment within `radius` of this row, as a range of x.
    let t0 = 0, t1 = 1;
    if (dy) {
      const u = (row * size - radius - a.y) / dy, v = ((row + 1) * size + radius - a.y) / dy;
      t0 = Math.max(0, Math.min(u, v)); t1 = Math.min(1, Math.max(u, v));
      if (t0 > t1) continue;
    }
    const x0 = a.x + t0 * (b.x - a.x), x1 = a.x + t1 * (b.x - a.x);
    const right = Math.min((cols ?? Infinity) - 1, Math.floor((Math.max(x0, x1) + radius) / size));
    for (let col = Math.max(low, Math.floor((Math.min(x0, x1) - radius) / size)); col <= right; col++) visit(col, row);
  }
}
/** The map's playable area. Every match map has one; a map without it is rejected rather than bounded by a default shape. */
export function playableAreaOf(map: Pick<CollisionMap, 'playableArea'>): PlayableArea {
  if (!map.playableArea) throw new RangeError('Map has no playableArea');
  return map.playableArea;
}
export function insideMap(map: Pick<CollisionMap, 'width' | 'height' | 'playableArea'>, x: World, y: World, radius: World = 0): boolean {
  const area = playableAreaOf(map), size = area.cellSize;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0
    || x - radius < 0 || y - radius < 0 || x + radius > map.width || y + radius > map.height
    || x >= map.width || y >= map.height) return false;
  if (radius === 0) return occupiedCell(area, Math.floor(x / size), Math.floor(y / size));
  const left = Math.max(0, Math.floor((x - radius) / size));
  const right = Math.min(Math.ceil(map.width / size) - 1, Math.floor((x + radius) / size));
  const top = Math.max(0, Math.floor((y - radius) / size));
  const bottom = Math.min(Math.ceil(map.height / size) - 1, Math.floor((y + radius) / size));
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    if (occupiedCell(area, col, row)) continue;
    const nearX = Math.max(col * size, Math.min((col + 1) * size, x));
    const nearY = Math.max(row * size, Math.min((row + 1) * size, y));
    const ex = x - nearX, ey = y - nearY;
    if (ex * ex + ey * ey < radius * radius) return false;
  }
  return true;
}
export function canOccupy(map: CollisionMap, x: World, y: World, radius: World = 12, ignoreGates = false, projectile = false): boolean {
  count('calls.canOccupy');
  if (!insideMap(map, x, y, radius)) return false;
  const circle = new SAT.Circle(vec(x, y), radius), response = new SAT.Response();
  for (const o of nearbyShapes(map, x, y, radius)) {
    if (projectile && seeThrough(o.kind)) continue;
    if (!nearBounds(o.box, x, y, radius)) continue;
    response.clear();
    if (separate(circle, o.shape, o.body, response) && response.overlap > 0.01) return false;
  }
  if (!ignoreGates) for (const g of gatesNear(map, x - radius, y - radius, x + radius, y + radius)) if (!g.open) {
    const box = gateShape(g);
    if (!nearBounds(box, x, y, radius)) continue;
    const o = collider(box);
    if (separate(circle, o.shape, o.body)) return false;
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
  const { buckets } = geometry(map), seen = new Set<Collider>();
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

/** Shared SAT sliding for tools and actors with explicit body dimensions. Input is normalized here. */
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
  const circle = new SAT.Circle(vec(p.x + x / norm * speed, p.y + y / norm * speed), radius);
  const response = new SAT.Response();
  const colliders: Collider[] = [...nearbyShapes(map, circle.pos.x, circle.pos.y, radius + speed)].filter(o => nearBounds(o.box, circle.pos.x, circle.pos.y, radius + speed));
  const reach = radius + speed;
  for (const g of gatesNear(map, circle.pos.x - reach, circle.pos.y - reach, circle.pos.x + reach, circle.pos.y + reach)) if (!g.open) {
    const box = gateShape(g);
    if (nearBounds(box, circle.pos.x, circle.pos.y, reach)) colliders.push(collider(box));
  }
  for (const box of voidCellsNear(map, circle.pos.x, circle.pos.y, radius + speed)) colliders.push(collider(box));
  // SAT separation provides continuous sliding along walls and around obstacle corners.
  for (let pass = 0; pass < 3; pass++) for (const o of colliders) {
    response.clear();
    if (separate(circle, o.shape, o.body, response)) circle.pos.sub(response.overlapV);
  }
  circle.pos.x = Math.max(radius, Math.min(map.width - radius, circle.pos.x));
  circle.pos.y = Math.max(radius, Math.min(map.height - radius, circle.pos.y));
  // A deep-void start has no well-defined SAT escape direction. Keep the last valid placement.
  if (!insideMap(map, circle.pos.x, circle.pos.y, radius)) { circle.pos.x = p.x; circle.pos.y = p.y; }
  p.x = Math.round(circle.pos.x * 1000) / 1000; p.y = Math.round(circle.pos.y * 1000) / 1000;
  return p;
}
const TAU = Math.PI * 2;
function hitRay(origin: Vec2, dx: number, dy: number, edge: Edge): number {
  const sx = edge.b.x - edge.a.x, sy = edge.b.y - edge.a.y;
  const cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-9) return Infinity;
  const ax = edge.a.x - origin.x, ay = edge.a.y - origin.y;
  const t = (ax * sy - ay * sx) / cross, u = (ax * dy - ay * dx) / cross;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}
export function lineClear(map: CollisionMap, a: Vec2, b: Vec2, ignoreGateId: GateId | null = null): boolean {
  count('calls.lineClear');
  const length = hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return true;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  let tests = 0;
  const blocks = (edge: Edge) => (tests++, Math.max(edge.a.x, edge.b.x) >= left && Math.min(edge.a.x, edge.b.x) <= right
    && Math.max(edge.a.y, edge.b.y) >= top && Math.min(edge.a.y, edge.b.y) <= bottom
    && hitRay(a, dx, dy, edge) < length - 0.1);
  // Only edges near the segment, found through the buckets: the answer is whether any edge blocks, so it
  // is the same as testing every obstacle edge and closed gate's edge, whatever order they are met in.
  const { segments, sight } = geometry(map), gates = gateIndex(map);
  const blocked = someAlong(sight, a, b, i => blocks(segments[i])) || someAlong(gates.buckets, a, b, i => {
    const g = map.gates[i];
    if (g.open || g.id === ignoreGateId) return false;
    const box = gateShape(g);
    return box.x + box.w >= left && box.x <= right && box.y + box.h >= top && box.y <= bottom && gateEdges(map, gates, i).some(blocks);
  });
  count('work.rayEdgeTests', tests);
  return !blocked;
}
// Hands and dropped equipment cannot pass through a window or pipe even though sight and shots can.
export function reachClear(map: CollisionMap, a: Vec2, b: Vec2): boolean {
  if (!lineClear(map, a, b)) return false;
  const length = hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return true;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  return !someAlong(geometry(map).buckets, a, b, o => seeThrough(o.kind) && edgesOf(o.shape).some(edge => hitRay(a, dx, dy, edge) < length));
}
export function visibilityPolygon(map: CollisionMap, origin: Vec2, radius: World = VISION): VisibilityPoint[] {
  count('calls.visibilityPolygon');
  // A ray can only strike a segment from within the angular wedge its endpoints subtend. Rays are cast
  // in ascending angle, so sweeping the wedges in the same order keeps an active set of just the few
  // segments any one ray can reach, instead of testing every segment against every ray.
  const angles = Array.from({ length: 100 }, (_, i) => i * Math.PI / 50 - Math.PI);
  const spans: { edge: Edge; lo: number; hi: number }[] = [], always: Edge[] = [];
  const SEAM = Math.PI + 1e-4; // Sample angles straddle +-pi by the corner offset below; keep them covered.
  const consider = (edge: Edge) => {
    if (Math.min(edge.a.x, edge.b.x) >= origin.x + radius || Math.max(edge.a.x, edge.b.x) <= origin.x - radius
      || Math.min(edge.a.y, edge.b.y) >= origin.y + radius || Math.max(edge.a.y, edge.b.y) <= origin.y - radius) return;
    const ea = atan2(edge.a.y - origin.y, edge.a.x - origin.x), eb = atan2(edge.b.y - origin.y, edge.b.x - origin.x);
    angles.push(ea - 0.00001, ea, ea + 0.00001, eb - 0.00001, eb, eb + 0.00001);
    // The wedge argument assumes the origin lies strictly off the segment. An origin on it — along an
    // edge or exactly at a corner — is grazed at distance zero from every direction and its endpoint
    // angles are degenerate, so such a segment is never culled.
    const sx = edge.b.x - edge.a.x, sy = edge.b.y - edge.a.y;
    const ox = origin.x - edge.a.x, oy = origin.y - edge.a.y;
    const cross = sx * oy - sy * ox, lengthSq = sx * sx + sy * sy, along = sx * ox + sy * oy;
    if (cross * cross <= 1e-12 * lengthSq && along >= -1e-9 && along <= lengthSq + 1e-9) { always.push(edge); return; }
    const lo = Math.min(ea, eb), hi = Math.max(ea, eb);
    // A straight segment never subtends more than pi from outside itself, so a wider naive span means
    // the wedge crosses the -pi/pi seam. Split it there so every span is a plain ascending interval.
    if (hi - lo > Math.PI) { spans.push({ edge, lo: hi, hi: SEAM }, { edge, lo: -SEAM, hi: lo }); return; }
    spans.push({ edge, lo, hi });
    // A direction is the same one turn either way, so a wedge touching a seam also has to catch the
    // sample angles sitting just past the opposite one. Ray -pi and ray +pi point the same way.
    if (hi >= Math.PI - 1e-4) spans.push({ edge, lo: lo - TAU, hi: hi - TAU });
    if (lo <= 1e-4 - Math.PI) spans.push({ edge, lo: lo + TAU, hi: hi + TAU });
  };
  // The edges the box test above passes, each once: obstacle edges and closed gates' edges from the cells the
  // box touches. That set is all the polygon depends on, not the order it is met in: `angles` is sorted by
  // value, and a ray's length is the least hit over the spans active at its angle, whichever order they enter.
  const { segments, sight } = geometry(map), gates = gateIndex(map);
  const left = origin.x - radius, top = origin.y - radius, right = origin.x + radius, bottom = origin.y + radius;
  visitedEdges.begin(segments.length); visitedGates.begin(map.gates.length);
  eachCellIn(sight, left, top, right, bottom, list => { for (const i of list) if (visitedEdges.first(i)) consider(segments[i]); });
  eachCellIn(gates.buckets, left, top, right, bottom, list => {
    for (const i of list) if (!map.gates[i].open && visitedGates.first(i)) for (const edge of gateEdges(map, gates, i)) consider(edge);
  });
  angles.sort((a, b) => a - b);
  spans.sort((a, b) => a.lo - b.lo);
  const active: { edge: Edge; lo: number; hi: number }[] = [];
  let entering = 0, tests = 0;
  const points = angles.map(angle => {
    while (entering < spans.length && spans[entering].lo <= angle) active.push(spans[entering++]);
    for (let i = active.length - 1; i >= 0; i--) if (active[i].hi < angle) { active[i] = active[active.length - 1]; active.pop(); }
    const dx = cos(angle), dy = sin(angle);
    let length = radius;
    for (const span of active) { tests++; const hit = hitRay(origin, dx, dy, span.edge); if (hit < length) length = hit; }
    for (const edge of always) { tests++; const hit = hitRay(origin, dx, dy, edge); if (hit < length) length = hit; }
    // Each vertex keeps the angle that produced it so the polygon can be queried directly, without
    // casting a fresh ray per entity the renderer wants to test.
    return { x: origin.x + dx * length, y: origin.y + dy * length, angle, length };
  });
  count('work.visibilityRays', tests);
  return points;
}


// Is a world point inside an already-computed visibility polygon? The vertices ascend by angle, so the
// bracketing pair is a binary search away and the test is which side of that boundary edge the point
// falls on. Reusing the polygon keeps the renderer's per-entity visibility exactly consistent with the
// fog it draws, and costs a log-time lookup instead of a ray cast per entity.
export function litPoint(points: VisibilityPoint[] | null | undefined, origin: Vec2, x: World, y: World): boolean {
  if (!points || points.length < 3) return false;
  const angle = atan2(y - origin.y, x - origin.x);
  let lo: number, hi: number;
  if (angle < points[0].angle || angle > points[points.length - 1].angle) { lo = points.length - 1; hi = 0; }
  else {
    lo = 0; hi = points.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].angle <= angle) lo = mid; else hi = mid; }
  }
  const a = points[lo], b = points[hi];
  const ex = b.x - a.x, ey = b.y - a.y;
  const side = ex * (y - a.y) - ey * (x - a.x), inner = ex * (origin.y - a.y) - ey * (origin.x - a.x);
  // A degenerate boundary edge means the wedge has no interior — an eye buried in geometry collapses
  // the whole polygon to a point — so nothing in it is lit.
  if (inner === 0) return false;
  return side === 0 || side > 0 === inner > 0;
}
