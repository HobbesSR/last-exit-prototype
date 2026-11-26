import { count } from './profiler.ts';
import { shapeOf, bounds, edgesOf } from './shape.ts';
import type { Edge } from './shape.ts';
import type { Box, CollisionMap, Gate, GateId, Obstacle, Vec2, World } from './types.ts';
import { atan2, hypot } from './math.ts';
import { BUCKET, bucketBox, cellsAlong, flatGrid } from './buckets.ts';
import { gateIndex, gateShape } from './gate-index.ts';
import { obstacleCache, PREPARATION_CHUNK, type ObstacleCache } from './obstacle-cache.ts';

// Sight casting (#1184): rays against the map's edges, for lines of sight, reach and visibility polygons.
// It owns its own index of what blocks sight, built from the obstacle list; collision (`movement.ts`) keeps
// its colliders separately, and both read where the gates are from `gate-index.ts`.

/**
 * Whether sight and shots pass an obstacle of this kind while bodies and hands do not (29): a
 * window, a low pipe run or a hedge, which the game, being 2D, treats the same way (17.2.8 M34).
 */
export const seeThrough = (kind: string | undefined): boolean => kind === 'window' || kind === 'pipe' || kind === 'hedge';
/** How far an eye sees, in world units. */
export const VISION = 620;
/** A visibility polygon vertex, which keeps the ray angle that produced it. */
export interface VisibilityPoint extends Vec2 {
  angle: number;
  length: World;
}
/**
 * What casts visibility polygons for a game: the Rust core (`sight-core.ts`, `rust/core/src/sight.rs`),
 * which `createGame` attaches to every stepping game. The TypeScript cast retired in #1175; this module
 * keeps the index the core is uploaded from, line and reach checks, and `litPoint`.
 */
export interface SightCaster {
  visibilityPolygon(map: CollisionMap, origin: Vec2, radius?: World): VisibilityPoint[];
}

interface SightIndex {
  count: number;
  /** Every edge of every obstacle that blocks sight, in obstacle order. */
  segments: Edge[];
  /** Indices into `segments`, bucketed by `BUCKET`-sized cell, each under every cell its bounds touch. */
  sight: Map<string, number[]>;
  /** The edges of each see-through obstacle, in obstacle order: hands stop at them. */
  windows: Edge[][];
  /** Indices into `windows`, bucketed under every cell the obstacle's bounds touch. */
  through: Map<string, number[]>;
}
const edgeBox = (edge: Edge): Box => {
  const x = Math.min(edge.a.x, edge.b.x), y = Math.min(edge.a.y, edge.b.y);
  return { x, y, w: Math.max(edge.a.x, edge.b.x) - x, h: Math.max(edge.a.y, edge.b.y) - y };
};
function* buildSightIndex(obstacles: readonly Obstacle[]): Generator<void, SightIndex> {
  const segments: Edge[] = [], sight = new Map<string, number[]>(), windows: Edge[][] = [], through = new Map<string, number[]>();
  let work = 0;
  for (const o of obstacles) {
    const shape = shapeOf(o);
    if (seeThrough(o.kind)) { bucketBox(through, bounds(shape), windows.length); windows.push(edgesOf(shape)); }
    else for (const edge of edgesOf(shape)) {
      const i = segments.length;
      segments.push(edge);
      bucketBox(sight, edgeBox(edge), i);
    }
    if (++work % PREPARATION_CHUNK === 0) yield;
  }
  if (work % PREPARATION_CHUNK !== 0) yield;
  return { count: obstacles.length, segments, sight, windows, through };
}
const sightIndex: ObstacleCache<SightIndex> = obstacleCache(buildSightIndex);
/** Prepare the sight index ahead of the first query, yielding between bounded batches (see `ObstacleCache`). */
export const prepareSightIndex = (map: Pick<CollisionMap, 'obstacles'>, yieldControl: () => Promise<void>): Promise<void> => sightIndex.prepare(map, yieldControl);

// Each gate's sight edges, built on first use, since a map copy that differs only in its gates (such as a
// contestant's remembered doors) copies the gate list. Indexed like `map.gates`, and rebuilt when the list grows.
const gateEdgeCache = new WeakMap<Gate[], { count: number; edges: (Edge[] | undefined)[] }>();
function gateEdgeList(map: Pick<CollisionMap, 'gates'>): (Edge[] | undefined)[] {
  let cached = gateEdgeCache.get(map.gates);
  if (cached?.count !== map.gates.length) gateEdgeCache.set(map.gates, cached = { count: map.gates.length, edges: [] });
  return cached.edges;
}
const gateEdges = (map: Pick<CollisionMap, 'gates'>, edges: (Edge[] | undefined)[], i: number): Edge[] => edges[i] ??= edgesOf(shapeOf(gateShape(map.gates[i])));

const flatEdges = (edges: Edge[]): Float64Array => Float64Array.from(edges.flatMap(e => [e.a.x, e.a.y, e.b.x, e.b.y]));
/** Lists of edges as one flat edge array and `lists.length + 1` offsets, list `i` from `offsets[i]` to `offsets[i + 1]`. */
function flatLists(lists: Edge[][]): { edges: Float64Array; offsets: Uint32Array } {
  const offsets = new Uint32Array(lists.length + 1);
  lists.forEach((list, i) => { offsets[i + 1] = offsets[i] + list.length; });
  return { edges: flatEdges(lists.flat()), offsets };
}
/**
 * The sight index as flat arrays for the Rust core (#1175): `[ax, ay, bx, by]` per edge, and its cells; and
 * the see-through obstacles' edges, with offsets per obstacle, and their cells (#1233, `reachClear`).
 */
export function sightTables(map: Pick<CollisionMap, 'obstacles'>): {
  segments: Float64Array; grid: Int32Array; through: { edges: Float64Array; offsets: Uint32Array; grid: Int32Array };
} {
  const { segments, sight, windows, through } = sightIndex.get(map);
  return { segments: flatEdges(segments), grid: flatGrid(sight), through: { ...flatLists(windows), grid: flatGrid(through) } };
}
/**
 * The gates as flat arrays for the Rust core: every gate's edges, open or not, with offsets per gate; their
 * boxes (`gateShape`, `x, y, w, h`), which collision tests; and their cells.
 */
export function gateTables(map: Pick<CollisionMap, 'gates'>): { edges: Float64Array; offsets: Uint32Array; boxes: Float64Array; grid: Int32Array } {
  const cached = gateEdgeList(map);
  const boxes = Float64Array.from(map.gates.flatMap(g => { const box = gateShape(g); return [box.x, box.y, box.w, box.h]; }));
  return { ...flatLists(map.gates.map((_, i) => gateEdges(map, cached, i))), boxes, grid: flatGrid(gateIndex(map).buckets) };
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
  const { segments, sight } = sightIndex.get(map), gates = gateIndex(map), edges = gateEdgeList(map);
  const blocked = someAlong(sight, a, b, i => blocks(segments[i])) || someAlong(gates.buckets, a, b, i => {
    const g = map.gates[i];
    if (g.open || g.id === ignoreGateId) return false;
    const box = gateShape(g);
    return box.x + box.w >= left && box.x <= right && box.y + box.h >= top && box.y <= bottom && gateEdges(map, edges, i).some(blocks);
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
  const { windows, through } = sightIndex.get(map);
  return !someAlong(through, a, b, i => windows[i].some(edge => hitRay(a, dx, dy, edge) < length));
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
