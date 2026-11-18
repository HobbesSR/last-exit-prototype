import { count } from './profiler.ts';
import { shapeOf, bounds, edgesOf } from './shape.ts';
import type { Edge } from './shape.ts';
import type { Box, CollisionMap, Gate, GateId, Obstacle, Vec2, World } from './types.ts';
import { atan2, cos, hypot, sin } from './math.ts';
import { BUCKET, bucketBox, cellsAlong, eachCellIn, Visited } from './buckets.ts';
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

interface SightIndex {
  count: number;
  /** Every edge of every obstacle that blocks sight, in obstacle order. */
  segments: Edge[];
  /** Indices into `segments`, bucketed by `BUCKET`-sized cell, each under every cell its bounds touch. */
  sight: Map<string, number[]>;
  /** The edges of each see-through obstacle, bucketed under every cell its bounds touch: hands stop at them. */
  through: Map<string, Edge[][]>;
}
const edgeBox = (edge: Edge): Box => {
  const x = Math.min(edge.a.x, edge.b.x), y = Math.min(edge.a.y, edge.b.y);
  return { x, y, w: Math.max(edge.a.x, edge.b.x) - x, h: Math.max(edge.a.y, edge.b.y) - y };
};
function* buildSightIndex(obstacles: readonly Obstacle[]): Generator<void, SightIndex> {
  const segments: Edge[] = [], sight = new Map<string, number[]>(), through = new Map<string, Edge[][]>();
  let work = 0;
  for (const o of obstacles) {
    const shape = shapeOf(o);
    if (seeThrough(o.kind)) bucketBox(through, bounds(shape), edgesOf(shape));
    else for (const edge of edgesOf(shape)) {
      const i = segments.length;
      segments.push(edge);
      bucketBox(sight, edgeBox(edge), i);
    }
    if (++work % PREPARATION_CHUNK === 0) yield;
  }
  if (work % PREPARATION_CHUNK !== 0) yield;
  return { count: obstacles.length, segments, sight, through };
}
const sightIndex: ObstacleCache<SightIndex> = obstacleCache(buildSightIndex);
/** Prepare the sight index ahead of the first query, yielding between bounded batches (see `ObstacleCache`). */
export const prepareSightIndex = (map: Pick<CollisionMap, 'obstacles'>, yieldControl: () => Promise<void>): Promise<void> => sightIndex.prepare(map, yieldControl);

// Each gate's sight edges, built on first use, since a contestant's local map (dynamic-navigation.ts) copies
// the gate list when a door changes. Indexed like `map.gates`, and rebuilt when the list grows.
const gateEdgeCache = new WeakMap<Gate[], { count: number; edges: (Edge[] | undefined)[] }>();
function gateEdgeList(map: Pick<CollisionMap, 'gates'>): (Edge[] | undefined)[] {
  let cached = gateEdgeCache.get(map.gates);
  if (cached?.count !== map.gates.length) gateEdgeCache.set(map.gates, cached = { count: map.gates.length, edges: [] });
  return cached.edges;
}
const gateEdges = (map: Pick<CollisionMap, 'gates'>, edges: (Edge[] | undefined)[], i: number): Edge[] => edges[i] ??= edgesOf(shapeOf(gateShape(map.gates[i])));
const visitedGates = new Visited(), visitedEdges = new Visited();

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
  return !someAlong(sightIndex.get(map).through, a, b, edges => edges.some(edge => hitRay(a, dx, dy, edge) < length));
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
  const { segments, sight } = sightIndex.get(map), gates = gateIndex(map), edges = gateEdgeList(map);
  const left = origin.x - radius, top = origin.y - radius, right = origin.x + radius, bottom = origin.y + radius;
  visitedEdges.begin(segments.length); visitedGates.begin(map.gates.length);
  eachCellIn(sight, left, top, right, bottom, list => { for (const i of list) if (visitedEdges.first(i)) consider(segments[i]); });
  eachCellIn(gates.buckets, left, top, right, bottom, list => {
    for (const i of list) if (!map.gates[i].open && visitedGates.first(i)) for (const edge of gateEdges(map, edges, i)) consider(edge);
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
