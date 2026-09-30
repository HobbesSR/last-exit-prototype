/**
 * Clearance index and proven navigation lattice.
 *
 * Every lattice edge is an analytically checked swept-disc move, so a lattice
 * route is a real centered route for that body radius. The lattice is a
 * sufficient test, not a necessary one: a body may physically fit through a gap
 * the half-cell lattice cannot sample. Failing closed is deliberate.
 */
import { pointSegmentDistance, segmentSegmentDistance } from "./geometry.ts";
import type { Box, NavTarget } from "./types.ts";

interface WallIndex {
  cols: number;
  rows: number;
  buckets: number[][];
  clampX: (v: number) => number;
  clampY: (v: number) => number;
  stamp: Int32Array;
  tick: number;
  scratch: number[];
}
export interface Lattice {
  W: number;
  H: number;
  node: Uint8Array;
  hEdge: Uint8Array;
  vEdge: Uint8Array;
}

export const LATTICE_STEP = 0.5;
const EPS = 1e-9;
const indexes = new WeakMap<NavTarget, WallIndex>();
const lattices = new WeakMap<NavTarget, Map<number, Lattice>>();

export function clearNavCache(map: NavTarget): void {
  indexes.delete(map);
  lattices.delete(map);
}

function buildIndex(map: NavTarget): WallIndex {
  const cols = Math.max(1, Math.ceil(map.width) + 1),
    rows = Math.max(1, Math.ceil(map.height) + 1);
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  const clampX = (v: number) => Math.min(cols - 1, Math.max(0, Math.floor(v))),
    clampY = (v: number) => Math.min(rows - 1, Math.max(0, Math.floor(v)));
  map.walls.forEach((w, id: number) => {
    const x0 = clampX(Math.min(w.x1, w.x2)),
      x1 = clampX(Math.max(w.x1, w.x2));
    const y0 = clampY(Math.min(w.y1, w.y2)),
      y1 = clampY(Math.max(w.y1, w.y2));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) buckets[y * cols + x]!.push(id);
  });
  return {
    cols,
    rows,
    buckets,
    clampX,
    clampY,
    stamp: new Int32Array(map.walls.length),
    tick: 0,
    scratch: [],
  };
}
function indexFor(map: NavTarget): WallIndex {
  let index = indexes.get(map);
  if (!index) {
    index = buildIndex(map);
    indexes.set(map, index);
  }
  return index;
}
/** Wall ids whose bucket overlaps the query box; deduplicated, allocation free. */
function near(
  map: NavTarget,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  const index = indexFor(map);
  const out = index.scratch;
  out.length = 0;
  index.tick += 1;
  const x0 = index.clampX(minX),
    x1 = index.clampX(maxX),
    y0 = index.clampY(minY),
    y1 = index.clampY(maxY);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      for (const id of index.buckets[y * index.cols + x] ?? [])
        if (index.stamp[id] !== index.tick) {
          index.stamp[id] = index.tick;
          out.push(id);
        }
  return out;
}

export function pointClear(
  map: NavTarget,
  x: number,
  y: number,
  radius: number,
): boolean {
  for (const id of near(map, x - radius, y - radius, x + radius, y + radius)) {
    const w = map.walls[id]!;
    if (pointSegmentDistance(x, y, w.x1, w.y1, w.x2, w.y2) < radius - EPS)
      return false;
  }
  return true;
}
export function segmentClear(
  map: NavTarget,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  for (const id of near(
    map,
    Math.min(ax, bx) - radius,
    Math.min(ay, by) - radius,
    Math.max(ax, bx) + radius,
    Math.max(ay, by) + radius,
  )) {
    const w = map.walls[id]!;
    if (
      segmentSegmentDistance(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2) <
      radius - EPS
    )
      return false;
  }
  return true;
}

/**
 * Half-cell lattice of occupiable nodes and verified axis-aligned moves,
 * evaluated only inside `map.navBoxes` (defaults to the whole map).
 */
export function latticeFor(map: NavTarget, radius: number): Lattice {
  let byRadius = lattices.get(map);
  if (!byRadius) {
    byRadius = new Map();
    lattices.set(map, byRadius);
  }
  const cached = byRadius.get(radius);
  if (cached) return cached;
  const W = Math.round(map.width / LATTICE_STEP) + 1,
    H = Math.round(map.height / LATTICE_STEP) + 1;
  const node = new Uint8Array(W * H),
    hEdge = new Uint8Array(W * H),
    vEdge = new Uint8Array(W * H),
    done = new Uint8Array(W * H);
  const boxes =
    map.navBoxes ??
    (map.tiles?.length
      ? map.tiles.map((t): Box => [
          t.x,
          t.y,
          t.x + (map.params?.tileSize ?? 6),
          t.y + (map.params?.tileSize ?? 6),
        ])
      : ([[0, 0, map.width, map.height]] as Box[]));
  for (const [bx0, by0, bx1, by1] of boxes) {
    const gx0 = Math.round(bx0 / LATTICE_STEP),
      gx1 = Math.round(bx1 / LATTICE_STEP);
    const gy0 = Math.round(by0 / LATTICE_STEP),
      gy1 = Math.round(by1 / LATTICE_STEP);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * W + gx;
        if (done[i]) continue;
        done[i] = 1;
        const x = gx * LATTICE_STEP,
          y = gy * LATTICE_STEP;
        node[i] = pointClear(map, x, y, radius) ? 1 : 0;
        if (!node[i]) continue;
        if (gx + 1 < W)
          hEdge[i] = segmentClear(map, x, y, x + LATTICE_STEP, y, radius)
            ? 1
            : 0;
        if (gy + 1 < H)
          vEdge[i] = segmentClear(map, x, y, x, y + LATTICE_STEP, radius)
            ? 1
            : 0;
      }
  }
  // An edge is usable only when both of its endpoints were found occupiable.
  for (let gy = 0; gy < H; gy++)
    for (let gx = 0; gx < W; gx++) {
      const i = gy * W + gx;
      if (hEdge[i] && (gx + 1 >= W || !node[i + 1])) hEdge[i] = 0;
      if (vEdge[i] && (gy + 1 >= H || !node[i + W])) vEdge[i] = 0;
    }
  const value = { W, H, node, hEdge, vEdge };
  byRadius.set(radius, value);
  return value;
}

export function nodeIndex(map: NavTarget, x: number, y: number): number {
  const W = Math.round(map.width / LATTICE_STEP) + 1;
  const gx = Math.round(x / LATTICE_STEP),
    gy = Math.round(y / LATTICE_STEP);
  const H = Math.round(map.height / LATTICE_STEP) + 1;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return -1;
  return gy * W + gx;
}
export function occupiable(
  map: NavTarget,
  radius: number,
  x: number,
  y: number,
): boolean {
  const i = nodeIndex(map, x, y);
  return i >= 0 && latticeFor(map, radius).node[i] === 1;
}

/** Node indices reachable from (x, y) without leaving the inclusive box. */
export function reachable(
  map: NavTarget,
  radius: number,
  x: number | undefined,
  y: number | undefined,
  box: Box,
): Set<number> {
  const { W, H, node, hEdge, vEdge } = latticeFor(map, radius);
  const seen = new Set<number>();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return seen;
  const start = nodeIndex(map, x as number, y as number);
  if (start < 0 || !node[start]) return seen;
  const gx0 = Math.round(box[0] / LATTICE_STEP),
    gx1 = Math.min(W - 1, Math.round(box[2] / LATTICE_STEP));
  const gy0 = Math.round(box[1] / LATTICE_STEP),
    gy1 = Math.min(H - 1, Math.round(box[3] / LATTICE_STEP));
  const queue = [start];
  seen.add(start);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      gx = i % W,
      gy = (i - gx) / W;
    const push = (j: number) => {
      if (!seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    };
    if (gx < gx1 && hEdge[i]) push(i + 1);
    if (gx > gx0 && hEdge[i - 1]) push(i - 1);
    if (gy < gy1 && vEdge[i]) push(i + W);
    if (gy > gy0 && vEdge[i - W]) push(i - W);
  }
  return seen;
}
