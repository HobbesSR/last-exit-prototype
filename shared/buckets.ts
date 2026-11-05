import type { Box, World } from './types.ts';

// The fixed cell grid that static geometry queries share (#667, #668): movement's colliders, sight edges and
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
