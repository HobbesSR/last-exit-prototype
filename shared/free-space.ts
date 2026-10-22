import ClipperLib from 'clipper-lib';
import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { IndexHeap } from './index-heap.ts';
import { CIRCLE_SEGMENTS, outline, polygon, rect, shapeOf, type Shape } from './shape.ts';
import { gateShape } from './movement.ts';
import type { Box, CollisionMap, Vec2, World } from './types.ts';

/**
 * The shape module's free-space index (22.6, "Bottom level"): the ground a disk's centre may
 * occupy, as a constrained Delaunay triangulation. The open ground of a domain, outside the
 * outlines of everything a body collides with, is eroded by the disk's clearance (its
 * configuration space, as Recast erodes by an agent's radius), so any path inside the mesh keeps
 * that clearance and narrow passages are kept exactly rather than lost between samples.
 *
 * Only the mesh and its paths come from here. Whether a path is travelable is collision's to say:
 * a caller sweeps every segment with the body's own test, and a disagreement is a defect.
 */
export interface FreeSpace {
  /** The clearance the free space was eroded by. */
  clearance: World;
  /** Vertex coordinates, `x` then `y`. */
  points: Float64Array;
  /** Three vertex indices per triangle, counterclockwise: `cross(b - a, c - a) > 0`. Edge `k` runs from vertex `k` to `k + 1`. */
  triangles: Int32Array;
  /** For edge `t * 3 + k`, the same edge as its neighbour numbers it (`n * 3 + k'`), or -1 where it bounds the free space. */
  twins: Int32Array;
  /** A bucket grid of triangles over the mesh's bounds, for locating points. */
  locator: Grid;
}
interface Grid { x: World; y: World; size: World; cols: number; rows: number; starts: Int32Array; items: Int32Array }

/** Integer coordinates per world unit for clipping and triangulating, so collinearity and coincidence are exact. */
const SCALE = 256;
/** World units per locator bucket. */
const BUCKET = 64;
/**
 * How far a rounded corner of the eroded space may fall short of its true arc, and how much
 * further than the clearance it is eroded. The clipper rounds an arc's step count, so its last
 * chord can sag up to 2.25 times the tolerance; the margin covers that and integer rounding, so
 * every point of the mesh keeps at least the clearance.
 */
const ARC_TOLERANCE: World = 0.05;
const ERODE_MARGIN: World = 0.2;

/**
 * Triangulate `within ∩ open − blocked`, each a union of shapes, eroded by `clearance`. Circles
 * become circumscribed polygons, so the free space here never includes ground a circle covers.
 */
export function triangulateFreeSpace(within: readonly Shape[], open: readonly Shape[], blocked: readonly Shape[], clearance: World): FreeSpace {
  const { PolyType, ClipType, PolyFillType, JoinType, EndType } = ClipperLib;
  const area: ClipperLib.Paths = [], free: ClipperLib.Paths = [], eroded: ClipperLib.Paths = [], tidy: ClipperLib.Paths = [];
  const meet = new ClipperLib.Clipper();
  meet.AddPaths(within.map(pathOf), PolyType.ptSubject, true);
  meet.AddPaths(open.map(pathOf), PolyType.ptClip, true);
  meet.Execute(ClipType.ctIntersection, area, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const cut = new ClipperLib.Clipper();
  cut.AddPaths(area, PolyType.ptSubject, true);
  cut.AddPaths(blocked.map(pathOf), PolyType.ptClip, true);
  cut.Execute(ClipType.ctDifference, free, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const erode = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE * SCALE);
  erode.AddPaths(free, JoinType.jtRound, EndType.etClosedPolygon);
  erode.Execute(eroded, -(clearance + ERODE_MARGIN) * SCALE);
  // Strictly simple: rings may share a vertex but never touch another ring's edge, as the triangulation requires.
  const simple = new ClipperLib.Clipper();
  simple.StrictlySimple = true;
  simple.AddPaths(eroded, PolyType.ptSubject, true);
  simple.Execute(ClipType.ctUnion, tidy, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return triangulateRings(tidy.filter(ring => ring.length >= 3), clearance);
}

/** A shape's outline as one integer ring, wound one way, so overlapping shapes add under the non-zero rule. */
function pathOf(shape: Shape): ClipperLib.Path {
  const points = shape.kind === 'circle'
    // Circumscribed: each side touches the circle, so the polygon covers it.
    ? outline({ ...shape, r: shape.r / Math.cos(Math.PI / CIRCLE_SEGMENTS) })
    : outline(shape);
  const path = points.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
  return path;
}

function triangulateRings(rings: ClipperLib.Paths, clearance: World): FreeSpace {
  // Vertices, deduplicated, and the rings' edges between them.
  const index = new Map<string, number>(), coords: number[] = [];
  const vertex = (p: ClipperLib.IntPoint) => {
    const key = `${p.X},${p.Y}`;
    let i = index.get(key);
    if (i === undefined) { i = coords.length / 2; coords.push(p.X, p.Y); index.set(key, i); }
    return i;
  };
  const ringEdges: [number, number][] = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = vertex(ring[i]!), b = vertex(ring[(i + 1) % ring.length]!);
    if (a !== b) ringEdges.push([a, b]);
  }
  if (coords.length < 6) return emptySpace(clearance);
  const edges = splitAtVertices(coords, ringEdges);

  const del = new Delaunator(Float64Array.from(coords));
  const con = new Constrainautor(del);
  for (const [a, b] of edges) con.constrainOne(a, b);
  const { triangles, halfedges } = del;
  const count = triangles.length / 3;
  // A constraint marks one half-edge or both.
  const constrained = (e: number) => con.isConstrained(e) || halfedges[e]! >= 0 && con.isConstrained(halfedges[e]!);

  // Inside or outside, by parity: the hull's unconstrained edges face outside, and every
  // constrained edge separates free space from the rest.
  const inside = new Int8Array(count).fill(-1), queue: number[] = [];
  for (let e = 0; e < triangles.length; e++) if (halfedges[e] === -1) {
    const t = Math.floor(e / 3);
    if (inside[t] === -1) { inside[t] = constrained(e) ? 1 : 0; queue.push(t); }
  }
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q]!;
    for (let k = 0; k < 3; k++) {
      const e = t * 3 + k, h = halfedges[e]!;
      if (h < 0) continue;
      const n = Math.floor(h / 3);
      if (inside[n] !== -1) continue;
      inside[n] = constrained(e) ? 1 - inside[t]! : inside[t]!;
      queue.push(n);
    }
  }

  // Free triangles, renumbered and wound counterclockwise, each edge mapped from its half-edge.
  const compact = new Int32Array(count).fill(-1);
  let free = 0;
  for (let t = 0; t < count; t++) if (inside[t] === 1) compact[t] = free++;
  const out = new Int32Array(free * 3), slotOf = new Int32Array(triangles.length).fill(-1), halfOf = new Int32Array(free * 3);
  for (let t = 0; t < count; t++) {
    const c = compact[t]!;
    if (c < 0) continue;
    const a = triangles[t * 3]!, b = triangles[t * 3 + 1]!, d = triangles[t * 3 + 2]!;
    const turn = (coords[b * 2]! - coords[a * 2]!) * (coords[d * 2 + 1]! - coords[a * 2 + 1]!) - (coords[b * 2 + 1]! - coords[a * 2 + 1]!) * (coords[d * 2]! - coords[a * 2]!);
    // Delaunator's edge k runs from its vertex k to k + 1; reversed winding reverses the edges.
    const verts = turn > 0 ? [a, b, d] : [a, d, b], halves = turn > 0 ? [t * 3, t * 3 + 1, t * 3 + 2] : [t * 3 + 2, t * 3 + 1, t * 3];
    for (let k = 0; k < 3; k++) { out[c * 3 + k] = verts[k]!; halfOf[c * 3 + k] = halves[k]!; slotOf[halves[k]!] = c * 3 + k; }
  }
  const twins = new Int32Array(free * 3);
  for (let s = 0; s < free * 3; s++) { const h = halfedges[halfOf[s]!]!; twins[s] = h < 0 ? -1 : slotOf[h]!; }
  const points = Float64Array.from(coords, v => v / SCALE);
  return { clearance, points, triangles: out, twins, locator: gridOf(points, out, 3) };
}

function emptySpace(clearance: World): FreeSpace {
  return { clearance, points: new Float64Array(), triangles: new Int32Array(), twins: new Int32Array(),
    locator: { x: 0, y: 0, size: BUCKET, cols: 0, rows: 0, starts: new Int32Array(1), items: new Int32Array() } };
}

function splitAtVertices(coords: readonly number[], edges: readonly [number, number][]): [number, number][] {
  const size = BUCKET * SCALE, buckets = new Map<string, number[]>();
  for (let i = 0; i < coords.length / 2; i++) {
    const key = `${Math.floor(coords[i * 2]! / size)},${Math.floor(coords[i * 2 + 1]! / size)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push(i);
  }
  // An edge two rings share bounds neither side, so pieces cancel in pairs: what remains separates
  // free space from the rest, which is what the parity flood after triangulation needs.
  const pieces = new Map<string, [number, number, number]>();
  const add = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`, piece = pieces.get(key);
    if (piece) piece[2]++; else pieces.set(key, [a, b, 1]);
  };
  for (const [a, b] of edges) {
    const ax = coords[a * 2]!, ay = coords[a * 2 + 1]!, dx = coords[b * 2]! - ax, dy = coords[b * 2 + 1]! - ay, length = dx * dx + dy * dy;
    const on: [number, number][] = [];
    for (let bx = Math.floor(Math.min(ax, ax + dx) / size); bx <= Math.floor(Math.max(ax, ax + dx) / size); bx++)
      for (let by = Math.floor(Math.min(ay, ay + dy) / size); by <= Math.floor(Math.max(ay, ay + dy) / size); by++)
        for (const v of buckets.get(`${bx},${by}`) ?? []) {
          if (v === a || v === b) continue;
          const px = coords[v * 2]! - ax, py = coords[v * 2 + 1]! - ay, along = px * dx + py * dy;
          if (dx * py - dy * px === 0 && along > 0 && along < length) on.push([along, v]);
        }
    if (!on.length) { add(a, b); continue; }
    on.sort((p, q) => p[0] - q[0]);
    let from = a;
    for (const [, v] of on) { add(from, v); from = v; }
    add(from, b);
  }
  return [...pieces.values()].filter(piece => piece[2] % 2).map(([a, b]) => [a, b]);
}

/**
 * A bucket grid over the mesh's vertices of `members`, each `arity` vertex indices long (a
 * triangle, or a lone vertex), listing each member in every bucket its bounds touch.
 */
function gridOf(points: Float64Array, members: Int32Array, arity: number): Grid {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    left = Math.min(left, points[i]!); right = Math.max(right, points[i]!);
    top = Math.min(top, points[i + 1]!); bottom = Math.max(bottom, points[i + 1]!);
  }
  const cols = Math.max(1, Math.ceil((right - left) / BUCKET) + 1), rows = Math.max(1, Math.ceil((bottom - top) / BUCKET) + 1);
  const range = (m: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < arity; k++) {
      const v = members[m * arity + k]!, x = points[v * 2]!, y = points[v * 2 + 1]!;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return [Math.floor((x0 - left) / BUCKET), Math.floor((y0 - top) / BUCKET), Math.floor((x1 - left) / BUCKET), Math.floor((y1 - top) / BUCKET)] as const;
  };
  // Counting sort: sizes, then offsets, then fill.
  const starts = new Int32Array(cols * rows + 1), count = members.length / arity;
  for (let m = 0; m < count; m++) { const [c0, r0, c1, r1] = range(m); for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) starts[r * cols + c + 1]!++; }
  for (let i = 0; i < cols * rows; i++) starts[i + 1]! += starts[i]!;
  const items = new Int32Array(starts[cols * rows]!), fill = starts.slice(0, cols * rows);
  for (let m = 0; m < count; m++) { const [c0, r0, c1, r1] = range(m); for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fill[r * cols + c]!++] = m; }
  return { x: left, y: top, size: BUCKET, cols, rows, starts, items };
}

/** The triangle holding a point, edges included, or -1 outside the free space. */
export function locate(space: FreeSpace, point: Vec2): number {
  const { locator, points, triangles } = space;
  const col = Math.floor((point.x - locator.x) / locator.size), row = Math.floor((point.y - locator.y) / locator.size);
  if (col < 0 || row < 0 || col >= locator.cols || row >= locator.rows) return -1;
  const cell = row * locator.cols + col;
  for (let i = locator.starts[cell]!; i < locator.starts[cell + 1]!; i++) {
    const t = locator.items[i]!;
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) {
      const a = triangles[t * 3 + k]!, b = triangles[t * 3 + (k + 1) % 3]!;
      const ax = points[a * 2]!, ay = points[a * 2 + 1]!, dx = points[b * 2]! - ax, dy = points[b * 2 + 1]! - ay;
      // Within a millionth of a unit of the edge counts as on it.
      inside = dx * (point.y - ay) - dy * (point.x - ax) >= -1e-6 * Math.hypot(dx, dy);
    }
    if (inside) return t;
  }
  return -1;
}

const at = (space: FreeSpace, v: number): Vec2 => ({ x: space.points[v * 2]!, y: space.points[v * 2 + 1]! });
const vertexOf = (space: FreeSpace, t: number, k: number): number => space.triangles[t * 3 + (k % 3)]!;

/**
 * Where a point enters the free space: the point itself in it, or else the nearest point of it
 * within `reach`, nudged just inside, with its triangle; null when none is that near. A point
 * outside is a body standing nearer a wall than the clearance, or a stand rounding has put just
 * outside; the caller sweeps the connector between them at whatever radius that point is held to.
 */
export function entry(space: FreeSpace, point: Vec2, reach: World): { point: Vec2; triangle: number } | null {
  const own = locate(space, point);
  if (own >= 0) return { point, triangle: own };
  const { locator } = space;
  const c0 = Math.max(0, Math.floor((point.x - reach - locator.x) / locator.size)), c1 = Math.min(locator.cols - 1, Math.floor((point.x + reach - locator.x) / locator.size));
  const r0 = Math.max(0, Math.floor((point.y - reach - locator.y) / locator.size)), r1 = Math.min(locator.rows - 1, Math.floor((point.y + reach - locator.y) / locator.size));
  let best = reach, found: { point: Vec2; triangle: number } | null = null;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++)
    for (let i = locator.starts[r * locator.cols + c]!; i < locator.starts[r * locator.cols + c + 1]!; i++) {
      const t = locator.items[i]!;
      for (let k = 0; k < 3; k++) {
        if (space.twins[t * 3 + k]! >= 0) continue;
        const a = at(space, vertexOf(space, t, k)), b = at(space, vertexOf(space, t, k + 1)), near = closestOnSegment(point, a, b);
        const d = Math.hypot(near.x - point.x, near.y - point.y);
        if (d < best || d === best && found && t < found.triangle) {
          // A hundredth of a unit toward the triangle's centre puts the point strictly inside it.
          const centre = at(space, vertexOf(space, t, k + 2)), cx = (a.x + b.x + centre.x) / 3 - near.x, cy = (a.y + b.y + centre.y) / 3 - near.y, n = Math.hypot(cx, cy);
          best = d; found = { point: { x: near.x + cx / n * 0.01, y: near.y + cy / n * 0.01 }, triangle: t };
        }
      }
    }
  return found;
}

/** Whether point `p` lies on segment `ab`, within a millionth of a unit. */
function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax, dy = by - ay, n = dx * dx + dy * dy, side = dx * (py - ay) - dy * (px - ax);
  // Off the line first, which settles almost every call.
  if (side * side > 1e-12 * n) return false;
  const t = n ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / n)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy) <= 1e-6;
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y, n = dx * dx + dy * dy;
  const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export interface FreePath {
  /** From the start to the target. */
  points: Vec2[];
  length: World;
  /** Whether the first and last segments are connectors from an endpoint outside the free space. */
  leads: [boolean, boolean];
}

/**
 * Shortest-corridor paths from `from` to each of `targets`, or null for a target the mesh cannot
 * reach. An endpoint outside the free space enters it through `entry`, within `reach`. One search
 * over edge crossings, each costed from the one before to its nearest point, finds every target's corridor; the funnel
 * algorithm pulls each taut.
 */
export function freePaths(space: FreeSpace, from: Vec2, targets: readonly Vec2[], reach: World): (FreePath | null)[] {
  const start = entry(space, from, reach);
  if (!start) return targets.map(() => null);
  const ends = targets.map(target => entry(space, target, reach));
  const states = space.triangles.length, best = new Float64Array(states + targets.length).fill(Infinity);
  const parent = new Int32Array(states + targets.length).fill(-2);
  const waiting = new Map<number, number[]>();
  ends.forEach((end, i) => {
    if (!end) return;
    let list = waiting.get(end.triangle);
    if (!list) waiting.set(end.triangle, list = []);
    list.push(i);
  });
  let pending = [...waiting.values()].reduce((n, list) => n + list.length, 0);
  const heap = new IndexHeap(64);
  // Each state's crossing point: the nearest point of its edge to the crossing before, which
  // follows a taut path far better than edge midpoints do across large triangles.
  const where = new Float64Array(states * 2);
  const relax = (state: number, g: World, via: number) => { if (g < best[state]!) { best[state] = g; parent[state] = via; heap.push(state, g); return true; } return false; };
  const enter = (state: number, from: Vec2, g: World, via: number) => {
    // The state's edge, as its own triangle numbers it.
    const n = Math.floor(state / 3), k = state % 3, p = closestOnSegment(from, at(space, vertexOf(space, n, k)), at(space, vertexOf(space, n, k + 1)));
    if (relax(state, g + span(from, p), via)) { where[state * 2] = p.x; where[state * 2 + 1] = p.y; }
  };
  const span = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);
  // A state `n * 3 + k` is being in triangle n, having entered it through its edge k.
  for (const i of waiting.get(start.triangle) ?? []) relax(states + i, span(start.point, ends[i]!.point), -1);
  for (let k = 0; k < 3; k++) { const into = space.twins[start.triangle * 3 + k]!; if (into >= 0) enter(into, start.point, 0, -1); }
  while (heap.size && pending) {
    const state = heap.pop();
    if (heap.lastKey > best[state]!) continue;
    if (state >= states) { pending--; continue; }
    const t = Math.floor(state / 3), k = state % 3, g = best[state]!, entered = { x: where[state * 2]!, y: where[state * 2 + 1]! };
    for (const i of waiting.get(t) ?? []) relax(states + i, g + span(entered, ends[i]!.point), state);
    for (const j of [(k + 1) % 3, (k + 2) % 3]) {
      const into = space.twins[t * 3 + j]!;
      if (into >= 0) enter(into, entered, g, state);
    }
  }
  return targets.map((target, i) => {
    if (best[states + i] === Infinity) return null;
    const crossings: number[] = [];
    for (let state = parent[states + i]!; state >= 0; state = parent[state]!) crossings.push(state);
    const end = ends[i]!, points = funnel(space, start.point, end.point, crossings.reverse());
    const leads: [boolean, boolean] = [start.point !== from, end.point !== target];
    if (leads[0]) points.unshift({ x: from.x, y: from.y });
    if (leads[1]) points.push({ x: target.x, y: target.y });
    let length = 0;
    for (let s = 1; s < points.length; s++) length += span(points[s - 1]!, points[s]!);
    return { points, length, leads };
  });
}

/**
 * The corridor pulled taut: the simple stupid funnel algorithm (Mononen). Entering a triangle
 * through an edge, counterclockwise, the edge's first vertex is on the left.
 */
function funnel(space: FreeSpace, from: Vec2, to: Vec2, crossings: readonly number[]): Vec2[] {
  // Portal ends as vertex numbers, with the start as -1 and the goal as -2, and their coordinates.
  const count = crossings.length + 2, ends = new Int32Array(count * 2), xy = new Float64Array(count * 4);
  ends[0] = ends[1] = -1; ends[count * 2 - 2] = ends[count * 2 - 1] = -2;
  xy.set([from.x, from.y, from.x, from.y], 0); xy.set([to.x, to.y, to.x, to.y], (count - 1) * 4);
  crossings.forEach((s, c) => {
    const n = Math.floor(s / 3), k = s % 3, l = vertexOf(space, n, k), r = vertexOf(space, n, k + 1), i = c + 1;
    ends[i * 2] = l; ends[i * 2 + 1] = r;
    xy[i * 4] = space.points[l * 2]!; xy[i * 4 + 1] = space.points[l * 2 + 1]!; xy[i * 4 + 2] = space.points[r * 2]!; xy[i * 4 + 3] = space.points[r * 2 + 1]!;
  });
  // The apex and each side as a vertex number and its coordinates.
  let apex = -1, ax = from.x, ay = from.y, apexAt = 0;
  let left = -1, lx = ax, ly = ay, leftAt = 0, right = -1, rx = ax, ry = ay, rightAt = 0;
  const area = (bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const path = [from];
  for (let i = 1; i < count; i++) {
    const l = ends[i * 2]!, r = ends[i * 2 + 1]!, plx = xy[i * 4]!, ply = xy[i * 4 + 1]!, prx = xy[i * 4 + 2]!, pry = xy[i * 4 + 3]!;
    // A portal the apex lies on, as a stand on a mesh edge does, is crossed where the path already
    // is; seen edge-on, it would collapse the funnel onto one of its ends.
    if (l !== apex && r !== apex && onSegment(ax, ay, plx, ply, prx, pry)) continue;
    // A right end no further right than the funnel's narrows it, unless it crosses the left side.
    if (r !== apex && (right === apex || area(rx, ry, prx, pry) >= 0)) {
      if (left === apex || area(prx, pry, lx, ly) > 0) { right = r; rx = prx; ry = pry; rightAt = i; }
      else {
        path.push({ x: lx, y: ly }); apex = left; ax = lx; ay = ly; apexAt = leftAt;
        right = left; rx = lx; ry = ly; rightAt = leftAt; i = apexAt; continue;
      }
    }
    if (l !== apex && (left === apex || area(plx, ply, lx, ly) >= 0)) {
      if (right === apex || area(rx, ry, plx, ply) > 0) { left = l; lx = plx; ly = ply; leftAt = i; }
      else {
        path.push({ x: rx, y: ry }); apex = right; ax = rx; ay = ry; apexAt = rightAt;
        left = right; lx = rx; ly = ry; leftAt = rightAt; i = apexAt; continue;
      }
    }
  }
  const last = path.at(-1)!;
  if (last.x !== to.x || last.y !== to.y) path.push(to);
  return path;
}

/**
 * A map's free space within `domain`, a union of boxes, for a body of `clearance`: inside the
 * playable area, outside every obstacle and closed gate. Built on first use and kept per map,
 * key and clearance, so the cost is paid once per region and body. A mesh is rebuilt only when
 * the closed gates near its domain change, so a door rebuilds the regions it borders; a change to
 * the obstacle list rebuilds every one.
 */
export function mapFreeSpace(map: CollisionMap, key: string, domain: readonly Box[], clearance: World): FreeSpace {
  let cache = spaces.get(map);
  if (!cache || cache.obstacles !== map.obstacles || cache.count !== map.obstacles.length) {
    cache = { obstacles: map.obstacles, count: map.obstacles.length, buckets: obstacleBuckets(map), meshes: new Map() };
    spaces.set(map, cache);
  }
  const box = domain.reduce<Box | null>((all, b) => all ? union(all, b) : b, null);
  if (!box) return emptySpace(clearance);
  const gates = map.gates.filter(g => !g.open).map(gateShape).filter(g => meets(g, box));
  const signature = gates.map(g => `${g.x},${g.y},${g.w},${g.h}`).join(';');
  const kept = cache.meshes.get(`${key}@${clearance}`);
  if (kept && kept.signature === signature) return kept.space;
  const blocked: Shape[] = [];
  const seen = new Set<number>();
  for (let bx = Math.floor(box.x / OBSTACLE_BUCKET); bx <= Math.floor((box.x + box.w) / OBSTACLE_BUCKET); bx++)
    for (let by = Math.floor(box.y / OBSTACLE_BUCKET); by <= Math.floor((box.y + box.h) / OBSTACLE_BUCKET); by++)
      for (const i of cache.buckets.get(`${bx},${by}`) ?? []) if (!seen.has(i)) { seen.add(i); blocked.push(shapeOf(map.obstacles[i]!)); }
  for (const g of gates) blocked.push(rect(g.x, g.y, g.w, g.h));
  const space = triangulateFreeSpace(domain.map(b => rect(b.x, b.y, b.w, b.h)), openGround(map, box), blocked, clearance);
  cache.meshes.set(`${key}@${clearance}`, { signature, space });
  return space;
}

const spaces = new WeakMap<CollisionMap, { obstacles: CollisionMap['obstacles']; count: number; buckets: Map<string, number[]>; meshes: Map<string, { signature: string; space: FreeSpace }> }>();
const OBSTACLE_BUCKET = 192;

function obstacleBuckets(map: CollisionMap): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  map.obstacles.forEach((o, i) => {
    const shape = shapeOf(o), points = outline(shape);
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    // A circle's outline is inscribed; its radius bounds it.
    const pad = shape.kind === 'circle' ? shape.r : 0;
    for (let bx = Math.floor((Math.min(...xs) - pad) / OBSTACLE_BUCKET); bx <= Math.floor((Math.max(...xs) + pad) / OBSTACLE_BUCKET); bx++)
      for (let by = Math.floor((Math.min(...ys) - pad) / OBSTACLE_BUCKET); by <= Math.floor((Math.max(...ys) + pad) / OBSTACLE_BUCKET); by++) {
        const key = `${bx},${by}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(i);
      }
  });
  return buckets;
}

/** The ground `insideMap` accepts near `box`: the playable area's runs, or a default map's diamond. */
function openGround(map: CollisionMap, box: Box): Shape[] {
  const area = map.playableArea;
  if (!area) {
    const hx = map.width / 2 - 40, hy = map.height / 2 - 40, cx = map.width / 2, cy = map.height / 2;
    return [polygon(0, 0, [{ x: cx - hx, y: cy }, { x: cx, y: cy - hy }, { x: cx + hx, y: cy }, { x: cx, y: cy + hy }])];
  }
  // Runs that only touch would clip as separate rings, each eroded on its own, so each overlaps its
  // neighbours by a step of the integer grid; the erosion margin covers that sliver of void.
  const size = area.cellSize, shapes: Shape[] = [], overlap = 2 / SCALE;
  for (const { y, runs } of area.rows) {
    if ((y + 1) * size < box.y || y * size > box.y + box.h) continue;
    for (const [from, to] of runs) {
      const left = Math.max(from * size, box.x - size), right = Math.min(to * size, box.x + box.w + size, map.width);
      if (right > left) shapes.push(rect(left - overlap, y * size - overlap, right - left + 2 * overlap, Math.min(size, map.height - y * size) + 2 * overlap));
    }
  }
  return shapes;
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const meets = (a: Box, b: Box) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
