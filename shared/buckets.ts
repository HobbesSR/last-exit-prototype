import type { Box, Vec2, World } from './types.ts';

// The fixed cell grid that static geometry queries share (#667, #668): movement's colliders, sight's edges and
// gates, and the swept shapes for shots and the hook. One cell size and one keying, so a change is made once.

/** Cell side, in world units. */
export const BUCKET = 200;

/** List `entry` under every cell the box touches, keyed `"<col>,<row>"`, columns outer. */
export function bucketBox<T>(buckets: Map<string, T[]>, box: Box, entry: T): void {
  for (let x = Math.floor(box.x / BUCKET); x <= Math.floor((box.x + box.w) / BUCKET); x++) for (let y = Math.floor(box.y / BUCKET); y <= Math.floor((box.y + box.h) / BUCKET); y++) {
    const key = `${x},${y}`, list = buckets.get(key);
    if (list) list.push(entry); else buckets.set(key, [entry]);
  }
}

/** Each bucket list of the cells a box touches; the cell of every point in the box is visited. */
export function eachCellIn<T>(buckets: Map<string, T[]>, left: World, top: World, right: World, bottom: World, visit: (entries: T[]) => void): void {
  for (let x = Math.floor(left / BUCKET); x <= Math.floor(right / BUCKET); x++) for (let y = Math.floor(top / BUCKET); y <= Math.floor(bottom / BUCKET); y++) {
    const list = buckets.get(`${x},${y}`);
    if (list) visit(list);
  }
}

/**
 * A bucket map as one `i32` array for the Rust core (`rust/core/src/sight.rs`, `Grid`): `col0, row0,
 * cols, rows`, then `cols * rows + 1` offsets, then the entries. Cells run column outer, as
 * `eachCellIn` visits them, and each keeps its list in bucket order.
 */
export function flatGrid(buckets: Map<string, number[]>): Int32Array {
  const cells = [...buckets].map(([key, list]) => { const [col, row] = key.split(',').map(Number); return { col, row, list }; });
  if (!cells.length) return Int32Array.of(0, 0, 0, 0, 0);
  const col0 = Math.min(...cells.map(c => c.col)), row0 = Math.min(...cells.map(c => c.row));
  const cols = Math.max(...cells.map(c => c.col)) - col0 + 1, rows = Math.max(...cells.map(c => c.row)) - row0 + 1;
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  for (const { col, row, list } of cells) lists[(col - col0) * rows + (row - row0)] = list;
  const words = new Int32Array(5 + cols * rows + lists.reduce((sum, list) => sum + list.length, 0));
  words.set([col0, row0, cols, rows, 0]);
  let offset = 0, at = 5 + cols * rows;
  lists.forEach((list, i) => { offset += list.length; words[5 + i] = offset; words.set(list, at); at += list.length; });
  return words;
}

/**
 * Which indices a query has already met, for entries listed in several cells. `begin` starts a query in
 * constant time by moving to a fresh mark, so nothing is allocated per query once the array has grown.
 */
export class Visited {
  private marks = new Uint32Array(0);
  private mark = 0;
  begin(size: number): void {
    if (this.marks.length < size) this.marks = new Uint32Array(Math.max(size, this.marks.length * 2));
    if (++this.mark === 0xffffffff) { this.marks.fill(0); this.mark = 1; }
  }
  first(i: number): boolean {
    if (this.marks[i] === this.mark) return false;
    this.marks[i] = this.mark; return true;
  }
}

/**
 * Each cell of a `size` grid within `radius` of segment `ab`: row by row, only the columns the
 * segment's band crosses, so a long diagonal costs its length rather than its bounding square.
 * With `cols` and `rows`, cells are clamped to that grid; without, indices may be negative.
 */
export function cellsAlong(a: Vec2, b: Vec2, radius: number, size: number, visit: (col: number, row: number) => void, cols?: number, rows?: number): void {
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
