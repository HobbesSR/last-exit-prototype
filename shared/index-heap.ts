/**
 * A binary min-heap of integer indices by key, for searches over numbered nodes (tiles,
 * triangles, crossings). Equal keys pop the lower index first, so a search's order never depends
 * on insertion order. `lastKey` is the key of the index last popped: a search that pushes an index
 * again on improvement skips stale entries by comparing it with its own best.
 */
export class IndexHeap {
  private items: Int32Array;
  private keys: Float64Array;
  size = 0;
  lastKey = 0;
  constructor(capacity: number) { this.items = new Int32Array(Math.max(16, capacity)); this.keys = new Float64Array(this.items.length); }
  private less(i: number, j: number): boolean { return this.keys[i]! < this.keys[j]! || this.keys[i] === this.keys[j] && this.items[i]! < this.items[j]!; }
  private swap(i: number, j: number): void {
    const t = this.items[i]!, k = this.keys[i]!;
    this.items[i] = this.items[j]!; this.keys[i] = this.keys[j]!; this.items[j] = t; this.keys[j] = k;
  }
  push(item: number, key: number): void {
    if (this.size === this.items.length) {
      const items = new Int32Array(this.size * 2), keys = new Float64Array(this.size * 2);
      items.set(this.items); keys.set(this.keys); this.items = items; this.keys = keys;
    }
    let i = this.size++;
    this.items[i] = item; this.keys[i] = key;
    while (i > 0) { const up = (i - 1) >> 1; if (!this.less(i, up)) break; this.swap(i, up); i = up; }
  }
  pop(): number {
    const top = this.items[0]!; this.lastKey = this.keys[0]!;
    if (--this.size > 0) {
      this.items[0] = this.items[this.size]!; this.keys[0] = this.keys[this.size]!;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}
