import ClipperLib from 'clipper-lib';
import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { CIRCLE_SEGMENTS, bounds, outline, polygon, rect, sharesArea, type Shape } from './shape.ts';
import type { Vec2 } from './types.ts';

/**
 * Shape construction (29): union, subtraction and intersection over `shape.ts` shapes, and the
 * breakdown of a result into disjoint convex pieces, which is what collision, sight and an
 * addressed area (20.2) accept. A builder says what it submits — a hall's rectangle less its
 * routes, walls that meet at a corner — rather than trimming rectangles by hand.
 *
 * It works on the clipper's integer grid, `CLIP_SCALE` steps per world unit, so coincidence and
 * collinearity are exact and nothing depends on trig (#170). A result's corners are then put back
 * where they truly are: an input's corner exactly as given, and a corner the construction makes
 * at the crossing of the input edges it lies on, so a piece ends on a cut's surface rather than
 * up to half a grid step inside it. A sliver thinner than a grid step may be lost. Circles
 * become polygons circumscribed a grid step wide of them, taken from the grid.
 */
export const CLIP_SCALE = 256;
/** World units per bucket when splitting ring edges at the vertices that lie on them. */
const SPLIT_BUCKET = 64;

/**
 * What the inputs were before rounding, so a result can return to it: per axis, the first input
 * coordinate at each grid step; each input corner; and every input edge in world units.
 */
interface Snap { x: Map<number, number>; y: Map<number, number>; points: Map<string, Vec2>; edges: InputEdge[] }
/** An input edge as given, and as the clipper saw it. */
interface InputEdge { a: Vec2; b: Vec2; A: ClipperLib.IntPoint; B: ClipperLib.IntPoint }
const edgesOf = (points: readonly Vec2[], path: ClipperLib.Path): InputEdge[] =>
  points.map((a, i) => ({ a, b: points[(i + 1) % points.length]!, A: path[i]!, B: path[(i + 1) % path.length]! }));
const emptySnap = (): Snap => ({ x: new Map(), y: new Map(), points: new Map(), edges: [] });

/** A shape's outline as one integer ring, wound one way, so overlapping shapes add under the non-zero rule. */
export function clipPath(shape: Shape): ClipperLib.Path {
  return ringOf(shape.kind === 'circle'
    // Circumscribed: each side touches the circle, so the polygon covers it.
    ? outline({ ...shape, r: shape.r / Math.cos(Math.PI / CIRCLE_SEGMENTS) })
    : outline(shape));
}

function ringOf(points: readonly Vec2[], snap?: Snap, wound = true): ClipperLib.Path {
  const path = points.map(p => {
    const X = Math.round(p.x * CLIP_SCALE), Y = Math.round(p.y * CLIP_SCALE);
    if (snap && !snap.x.has(X)) snap.x.set(X, p.x);
    if (snap && !snap.y.has(Y)) snap.y.set(Y, p.y);
    if (snap && !snap.points.has(`${X},${Y}`)) snap.points.set(`${X},${Y}`, { x: p.x, y: p.y });
    return { X, Y };
  });
  if (snap) snap.edges.push(...edgesOf(points, path));
  if (wound && !ClipperLib.Clipper.Orientation(path)) path.reverse();
  return path;
}

/**
 * A circle's outline is trig, so it is known only on the grid: its edges join the grid points.
 * Its polygon is circumscribed a grid step wider, so rounding never brings a side inside it.
 */
function snappedPath(shape: Shape, snap: Snap): ClipperLib.Path {
  if (shape.kind !== 'circle') return ringOf(outline(shape), snap);
  const path = ringOf(outline({ ...shape, r: shape.r / Math.cos(Math.PI / CIRCLE_SEGMENTS) + 1 / CLIP_SCALE })), points = path.map(p => ({ x: p.X / CLIP_SCALE, y: p.Y / CLIP_SCALE }));
  snap.edges.push(...edgesOf(points, path));
  return path;
}

/** An area being constructed. Each step returns a new construction; none changes this one. */
export interface Construction {
  union(shapes: readonly Shape[]): Construction;
  /** Less `shapes`, each grown by `margin` world units first (mitred), so what is left keeps that far off them. */
  subtract(shapes: readonly Shape[], margin?: number): Construction;
  intersect(shapes: readonly Shape[]): Construction;
  /**
   * The area as disjoint convex pieces, in an order that depends only on the area. A part whose
   * edges are all axis-aligned breaks into rectangles, in rows or columns, whichever is fewer;
   * any other part into convex polygons. A polygon piece is anchored at the origin, so its
   * points are its world outline exactly.
   */
  pieces(): Shape[];
}

/** Start a construction from the union of `shapes`. */
export function construct(shapes: readonly Shape[] = []): Construction {
  const snap = emptySnap();
  return constructed(execute(ClipperLib.ClipType.ctUnion, shapes.map(s => snappedPath(s, snap)), []), snap);
}

/**
 * A concave or holed outline as disjoint convex pieces: world-space rings, filled by the
 * even-odd rule, so a ring inside another is a hole whichever way either winds. This is the
 * breakdown generated geometry needs before it becomes shapes (29).
 */
export function convexPieces(rings: readonly (readonly Vec2[])[]): Shape[] {
  const snap = emptySnap();
  const paths = rings.filter(r => r.length >= 3).map(r => ringOf(r, snap, false));
  return constructed(execute(ClipperLib.ClipType.ctUnion, paths, [], ClipperLib.PolyFillType.pftEvenOdd), snap).pieces();
}

/**
 * Each shape less every earlier one, so the result never overlaps itself: an earlier shape keeps
 * any place they share. A shape that shares area with no earlier shape, nor with what one came
 * back as, is returned as it is, circles included; one wholly covered adds nothing. What came back
 * is tested too because a cut circle's pieces reach a grid step past it. A shape that is cut has
 * every earlier shape near its grid outline subtracted, as a circle's outline reaches past it too.
 * The earlier shapes, not their pieces, are what is subtracted, so every cut is made on the same
 * grid. Overlap is `sharesArea` at the geometry tolerance, as the addressed record tests it (20.2).
 */
export function disjoint(shapes: readonly Shape[]): Shape[] {
  const returned: Shape[][] = [];
  shapes.forEach((shape, i) => {
    const box = bounds(shape), meets = (o: Shape) => boxesMeet(box, bounds(o)) && sharesArea(shape, o, OVERLAP);
    if (!shapes.slice(0, i).some((o, j) => meets(o) || returned[j]!.some(meets))) { returned.push([shape]); return; }
    const grid = gridBounds(shape, GRID_MARGIN), cut = shapes.slice(0, i).filter(o => boxesMeet(grid, gridBounds(o, GRID_MARGIN)));
    const pieces = construct([shape]).subtract(cut).pieces();
    // Inputs nearer one another than a grid step can leave an exact corner past the grid's cut;
    // then the cut is made again with the earlier shapes grown, leaving a gap of a step or two.
    const earlier = returned.flat(), clash = (p: Shape) => earlier.some(o => boxesMeet(bounds(p), bounds(o)) && sharesArea(p, o, OVERLAP));
    returned.push(pieces.some(clash) ? construct([shape]).subtract(cut, GRID_MARGIN).pieces() : pieces);
  });
  return returned.flat();
}
const OVERLAP = 1e-7;
/** Two grid steps: past where rounding can put an edge, so a cut grown by it leaves a gap. */
const GRID_MARGIN = 2 / CLIP_SCALE;
/** Bounds wide enough for a shape's outline on the grid, a circle's wider polygon included, and `margin` more. */
function gridBounds(shape: Shape, margin = 0): ReturnType<typeof bounds> {
  const box = bounds(shape.kind === 'circle' ? { ...shape, r: shape.r / Math.cos(Math.PI / CIRCLE_SEGMENTS) } : shape), pad = 2 / CLIP_SCALE + margin;
  return { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
}
const boxesMeet = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function constructed(rings: ClipperLib.Paths, snap: Snap): Construction {
  const step = (type: ClipperLib.ClipType) => (shapes: readonly Shape[], margin = 0): Construction => {
    const next: Snap = { x: new Map(snap.x), y: new Map(snap.y), points: new Map(snap.points), edges: [...snap.edges] };
    let by = shapes.map(s => snappedPath(s, next));
    if (margin > 0) {
      // Grown outlines are known only on the grid, as a circle's is.
      const grown: ClipperLib.Paths = [], offset = new ClipperLib.ClipperOffset(2);
      offset.AddPaths(by, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
      offset.Execute(grown, margin * CLIP_SCALE);
      for (const path of grown) next.edges.push(...edgesOf(path.map(p => ({ x: p.X / CLIP_SCALE, y: p.Y / CLIP_SCALE })), path));
      by = grown;
    }
    return constructed(execute(type, rings, by), next);
  };
  return {
    union: step(ClipperLib.ClipType.ctUnion),
    subtract: step(ClipperLib.ClipType.ctDifference),
    intersect: step(ClipperLib.ClipType.ctIntersection),
    pieces: () => piecesOf(rings, snap),
  };
}

function execute(type: ClipperLib.ClipType, subject: ClipperLib.Paths, by: ClipperLib.Paths, fill = ClipperLib.PolyFillType.pftNonZero): ClipperLib.Paths {
  const out: ClipperLib.Paths = [], clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(by, ClipperLib.PolyType.ptClip, true);
  clipper.Execute(type, out, fill, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

type Quad = [x0: number, y0: number, x1: number, y1: number];

function piecesOf(rings: ClipperLib.Paths, snap: Snap): Shape[] {
  // Strictly simple, as a tree: each outer ring with its holes is one part.
  const tree = new ClipperLib.PolyTree(), clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(rings, ClipperLib.PolyType.ptSubject, true);
  clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const parts: ClipperLib.Paths[] = [];
  const walk = (outers: ClipperLib.PolyNode[]) => {
    for (const outer of outers) {
      const part = canonicalRings([outer.Contour(), ...outer.Childs().map(hole => hole.Contour())]);
      if (part.length) parts.push(part);
      for (const hole of outer.Childs()) walk(hole.Childs());
    }
  };
  walk(tree.Childs());
  parts.sort((a, b) => a[0]![0]!.Y - b[0]![0]!.Y || a[0]![0]!.X - b[0]![0]!.X);

  const x = (X: number) => snap.x.get(X) ?? X / CLIP_SCALE, y = (Y: number) => snap.y.get(Y) ?? Y / CLIP_SCALE;
  const box = ([x0, y0, x1, y1]: Quad): Shape => { const left = x(x0), top = y(y0); return rect(left, top, x(x1) - left, y(y1) - top); };
  const pieces: Shape[] = [];
  for (const part of parts) {
    if (part.every(ring => ring.every((a, i) => { const b = ring[(i + 1) % ring.length]!; return a.X === b.X || a.Y === b.Y; }))) {
      const across = rows(part), down = rows(part.map(transposed)).map(([y0, x0, y1, x1]): Quad => [x0, y0, x1, y1]);
      pieces.push(...(down.length < across.length ? down : across).sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(box));
      continue;
    }
    for (const corners of convexMerge(part, p => cornerOf(p, snap))) pieces.push(rectangleOf(corners) ?? polygon(0, 0, corners));
  }
  return pieces;
}

/**
 * Where a result's corner truly is: an input corner as given, or else the crossing of the two
 * input edges it lies on, which the grid rounded. A corner on one edge only lies on that edge.
 * An axis-aligned edge keeps its own coordinate exactly.
 */
function cornerOf(p: ClipperLib.IntPoint, snap: Snap): Vec2 {
  const given = snap.points.get(`${p.X},${p.Y}`);
  if (given) return given;
  // The clipper's crossing is within a grid step of the rounded edges, however far along them
  // a shallow crossing's rounding moved it, so the edges are found on the grid.
  const near = snap.edges.filter(({ A, B }) => {
    const dx = B.X - A.X, dy = B.Y - A.Y, n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((p.X - A.X) * dx + (p.Y - A.Y) * dy) / n)) : 0;
    return Math.hypot(p.X - A.X - t * dx, p.Y - A.Y - t * dy) <= 1;
  });
  const px = p.X / CLIP_SCALE, py = p.Y / CLIP_SCALE;
  const fixed = (q: Vec2, ...on: InputEdge[]): Vec2 => {
    for (const { a, b } of on) { if (a.x === b.x) q.x = a.x; if (a.y === b.y) q.y = a.y; }
    return q;
  };
  // The pair the clipper crossed is the one whose rounded edges cross nearest the corner; the
  // corner is then where the edges as given cross.
  let best: Vec2 | undefined, distance = Infinity;
  for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
    const grid = crossing(near[i]!.A, near[i]!.B, near[j]!.A, near[j]!.B);
    if (!grid) continue;
    const off = Math.hypot(grid.x - p.X, grid.y - p.Y);
    if (off >= distance) continue;
    const q = crossing(near[i]!.a, near[i]!.b, near[j]!.a, near[j]!.b);
    if (q) { best = fixed(q, near[i]!, near[j]!); distance = off; }
  }
  if (best) return best;
  if (near.length) {
    const { a, b } = near[0]!, dx = b.x - a.x, dy = b.y - a.y, t = ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy);
    return fixed({ x: a.x + t * dx, y: a.y + t * dy }, near[0]!);
  }
  return { x: snap.x.get(p.X) ?? px, y: snap.y.get(p.Y) ?? py };
}

/** Where the lines through a → b and c → d cross, or nothing if they are parallel. */
function crossing(a: { x: number; y: number } | ClipperLib.IntPoint, b: typeof a, c: typeof a, d: typeof a): Vec2 | undefined {
  const [ax, ay, bx, by, cx, cy, dx, dy] = [a, b, c, d].flatMap(p => 'X' in p ? [p.X, p.Y] : [p.x, p.y]) as number[];
  const rx = bx! - ax!, ry = by! - ay!, sx = dx! - cx!, sy = dy! - cy!, denominator = rx * sy - ry * sx;
  if (!denominator) return undefined;
  const t = ((cx! - ax!) * sy - (cy! - ay!) * sx) / denominator;
  return { x: ax! + t * rx, y: ay! + t * ry };
}

const transposed = (ring: ClipperLib.Path): ClipperLib.Path => ring.map(p => ({ X: p.Y, Y: p.X }));

/**
 * A rectilinear part as rectangles: cut into bands at every vertex's y, each band into the
 * spans between the vertical edges crossing it, and a span carried down while the next band
 * has the same one.
 */
function rows(rings: ClipperLib.Paths): Quad[] {
  const levels = new Set<number>(), edges: [x: number, top: number, bottom: number][] = [];
  for (const ring of rings) ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    levels.add(a.Y);
    if (a.X === b.X) edges.push([a.X, Math.min(a.Y, b.Y), Math.max(a.Y, b.Y)]);
  });
  const ys = [...levels].sort((a, b) => a - b), done: Quad[] = [];
  let open = new Map<string, Quad>();
  for (let k = 0; k + 1 < ys.length; k++) {
    const top = ys[k]!, bottom = ys[k + 1]!, next = new Map<string, Quad>();
    // The part is strictly simple, so the edges crossing a band alternate in and out.
    const xs = edges.filter(([, t, b]) => t <= top && b >= bottom).map(([x]) => x).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const key = `${xs[i]},${xs[i + 1]}`, quad = open.get(key) ?? [xs[i]!, top, xs[i + 1]!, bottom];
      quad[3] = bottom;
      open.delete(key);
      next.set(key, quad);
    }
    done.push(...open.values());
    open = next;
  }
  return [...done, ...open.values()];
}

/**
 * A part as convex pieces (Hertel–Mehlhorn): triangulated, then each diagonal in turn removed
 * where the two pieces it parts make a convex one. At most four times the fewest convex pieces.
 * Convexity is judged at the corners `place` puts back, not on the grid, since putting them
 * back can move a corner across a diagonal; turns within `convex`'s tolerance are straight.
 */
function convexMerge(rings: ClipperLib.Paths, place: (p: ClipperLib.IntPoint) => Vec2): Vec2[][] {
  const mesh = triangulateRings(rings);
  if (!mesh) return [];
  const { triangles, twins } = mesh, count = triangles.length / 3;
  const corners = Array.from({ length: mesh.coords.length / 2 }, (_, v) => place({ X: mesh.coords[v * 2]!, Y: mesh.coords[v * 2 + 1]! }));
  const owner = Int32Array.from({ length: count }, (_, t) => t);
  const find = (t: number): number => owner[t] === t ? t : (owner[t] = find(owner[t]!));
  const loops = new Map<number, number[]>();
  for (let t = 0; t < count; t++) loops.set(t, [triangles[t * 3]!, triangles[t * 3 + 1]!, triangles[t * 3 + 2]!]);
  const turn = (i: number, j: number, k: number) => {
    const a = corners[i]!, b = corners[j]!, c = corners[k]!;
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  };
  for (let s = 0; s < triangles.length; s++) {
    const twin = twins[s]!;
    if (twin < s) continue;
    const p = find(Math.floor(s / 3)), q = find(Math.floor(twin / 3));
    if (p === q) continue;
    // Edge a → b runs counterclockwise round p, so b → a runs round q.
    const a = triangles[s]!, b = triangles[Math.floor(s / 3) * 3 + (s + 1) % 3]!;
    const left = rotated(loops.get(p)!, b, a), right = rotated(loops.get(q)!, a, b);
    if (!left || !right) continue;
    const merged = [...left, ...right.slice(1, -1)];
    if (!merged.every((v, i) => turn(merged[(i + merged.length - 1) % merged.length]!, v, merged[(i + 1) % merged.length]!) >= -STRAIGHT)) continue;
    owner[q] = p;
    loops.set(p, merged);
    loops.delete(q);
  }
  // A sliver whose corners all came back in line has no area left, and goes.
  return [...loops.values()].map(loop => {
    const kept = loop.filter((v, i) => Math.abs(turn(loop[(i + loop.length - 1) % loop.length]!, v, loop[(i + 1) % loop.length]!)) > STRAIGHT);
    return kept.map(v => corners[v]!);
  }).filter(piece => piece.length >= 3);
}

/** The turn `convex` (shape.ts) reads as straight. */
const STRAIGHT = 1e-9;

/** The loop started at `from` and ending at `to`, where `to` → `from` is one of its edges. */
function rotated(loop: readonly number[], from: number, to: number): number[] | undefined {
  for (let i = 0; i < loop.length; i++) {
    if (loop[i] !== from || loop[(i + loop.length - 1) % loop.length] !== to) continue;
    return [...loop.slice(i), ...loop.slice(0, i)];
  }
  return undefined;
}

/** A four-sided axis-aligned piece as a rect, or nothing. */
function rectangleOf(points: readonly Vec2[]): Shape | undefined {
  if (points.length !== 4 || !points.every((a, i) => { const b = points[(i + 1) % 4]!; return a.x === b.x || a.y === b.y; })) return undefined;
  const xs = points.map(p => p.x), ys = points.map(p => p.y), left = Math.min(...xs), top = Math.min(...ys);
  return rect(left, top, Math.max(...xs) - left, Math.max(...ys) - top);
}

/**
 * Rings in an order that depends only on the region they bound: repeated and collinear points
 * dropped, each ring started at its least point (by y, then x), and the rings sorted by it.
 * The clipper's own order follows its inputs', which would let geometry elsewhere change a tile.
 */
export function canonicalRings(rings: ClipperLib.Paths): ClipperLib.Paths {
  const out: ClipperLib.Paths = [];
  for (const ring of rings) {
    let points = ring;
    for (let changed = true; changed && points.length >= 3;) {
      changed = false;
      const kept: ClipperLib.Path = [];
      for (let i = 0; i < points.length; i++) {
        const a = kept.at(-1) ?? points.at(-1)!, p = points[i]!, b = points[(i + 1) % points.length]!;
        if (p.X === a.X && p.Y === a.Y || (p.X - a.X) * (b.Y - a.Y) - (p.Y - a.Y) * (b.X - a.X) === 0) { changed = true; continue; }
        kept.push(p);
      }
      points = kept;
    }
    if (points.length < 3) continue;
    let first = 0;
    points.forEach((p, i) => { const f = points[first]!; if (p.Y < f.Y || p.Y === f.Y && p.X < f.X) first = i; });
    out.push([...points.slice(first), ...points.slice(0, first)]);
  }
  return out.sort((a, b) => a[0]!.Y - b[0]!.Y || a[0]!.X - b[0]!.X || a.length - b.length || a[1]!.Y - b[1]!.Y || a[1]!.X - b[1]!.X);
}

/** A constrained triangulation of integer rings, in grid units. */
export interface RingMesh {
  /** Vertex coordinates, `X` then `Y`, deduplicated. */
  coords: number[];
  /** Three vertex indices per triangle inside the rings, counterclockwise: `cross(b - a, c - a) > 0`. */
  triangles: Int32Array;
  /** For edge `t * 3 + k`, the same edge as its neighbour numbers it, or -1 where it bounds the rings. */
  twins: Int32Array;
}

/**
 * Triangulate the inside of strictly simple integer rings, holes and all. Nothing when the
 * rings have fewer than three distinct points. The free-space index (22.6) meshes its ground
 * with it, and the convex breakdown merges its triangles.
 */
export function triangulateRings(rings: ClipperLib.Paths): RingMesh | undefined {
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
  if (coords.length < 6) return undefined;
  const edges = splitAtVertices(coords, ringEdges);

  const del = new Delaunator(Float64Array.from(coords));
  const con = new Constrainautor(del);
  for (const [a, b] of edges) con.constrainOne(a, b);
  const { triangles, halfedges } = del;
  const count = triangles.length / 3;
  // A constraint marks one half-edge or both.
  const constrained = (e: number) => con.isConstrained(e) || halfedges[e]! >= 0 && con.isConstrained(halfedges[e]!);

  // Inside or outside, by parity: the hull's unconstrained edges face outside, and every
  // constrained edge separates the inside from the rest.
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

  // Inside triangles, renumbered and wound counterclockwise, each edge mapped from its half-edge.
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
  return { coords, triangles: out, twins };
}

function splitAtVertices(coords: readonly number[], edges: readonly [number, number][]): [number, number][] {
  const size = SPLIT_BUCKET * CLIP_SCALE, buckets = new Map<string, number[]>();
  for (let i = 0; i < coords.length / 2; i++) {
    const key = `${Math.floor(coords[i * 2]! / size)},${Math.floor(coords[i * 2 + 1]! / size)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push(i);
  }
  // An edge two rings share bounds neither side, so pieces cancel in pairs: what remains separates
  // the inside from the rest, which is what the parity flood after triangulation needs.
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
