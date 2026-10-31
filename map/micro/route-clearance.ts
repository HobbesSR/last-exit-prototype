import { bounds, type Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { RegionMask } from './types.ts';
import { capsule, shapesOverlap } from './geometry.ts';

/** One immutable access mask/body/door policy and a monotonically growing collision prefix.
 * The caller must keep the mask unchanged; supply door colliders according to its policy.
 * Geometry is copied. No state is shared between factories, including equal-looking masks.
 * Only half-cell grid nodes/cardinal edges are memoized; arbitrary connectors remain exact.
 */
export function createRouteClearance(mask: RegionMask, initial: readonly Shape[], radius: number) {
  const step = mask.cellSize / 2, box = mask.bounds, bucketSize = mask.cellSize * 4;
  const width = Math.round(box.w / step) + 1, height = Math.round(box.h / step) + 1;
  // Five directed checks per grid point: standing, right, down, left, up.
  // 0 = unknown, 1 = blocked, 2 = clear at the accepted collision prefix.
  const accepted = new Uint8Array(width * height * 5);
  const visit = (shape: Shape, action: (key: string) => void) => {
    const b = bounds(shape);
    for (let y = Math.floor(b.y / bucketSize); y <= Math.floor((b.y + b.h) / bucketSize); y++)
      for (let x = Math.floor(b.x / bucketSize); x <= Math.floor((b.x + b.w) / bucketSize); x++) action(`${x},${y}`);
  };
  const index = (shapes: readonly Shape[]) => {
    const buckets = new Map<string, Shape[]>();
    const add = (shapes: readonly Shape[]) => {
      for (const shape of shapes) visit(shape, key => {
        const bucket = buckets.get(key);
        if (bucket) bucket.push(shape); else buckets.set(key, [shape]);
      });
    };
    add(shapes);
    return { add, query(shape: Shape): Shape[] {
      const found = new Set<Shape>();
      visit(shape, key => { for (const candidate of buckets.get(key) ?? []) found.add(candidate); });
      return [...found];
    } };
  };
  const blockers = index(structuredClone(initial));
  const gridPoint = (p: Vec2): number => {
    const x = (p.x - box.x) / step, y = (p.y - box.y) / step;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height
      || box.x + x * step !== p.x || box.y + y * step !== p.y) return -1;
    return y * width + x;
  };
  const checkId = (a: Vec2, b: Vec2): number => {
    const from = gridPoint(a), to = gridPoint(b);
    if (from < 0 || to < 0) return -1;
    if (from === to) return from * 5;
    if (a.y === b.y && b.x - a.x === step) return from * 5 + 1;
    if (a.x === b.x && b.y - a.y === step) return from * 5 + 2;
    if (a.y === b.y && a.x - b.x === step) return from * 5 + 3;
    if (a.x === b.x && a.y - b.y === step) return from * 5 + 4;
    return -1;
  };
  let version = 0;
  const trial = (added: readonly Shape[], publish: boolean) => {
    const at = version, pending = new Map<number, number>();
    const additions = index(added);
    const affected = new Uint8Array(width * height), changed: number[] = [];
    // Every cached sweep starts at a and extends at most one step plus radius.
    // Expanded bounds conservatively include every potentially affected start,
    // including both ends of an edge. False positives only trigger exact rechecks.
    for (const shape of added) {
      const b = bounds(shape), margin = radius + step;
      const x0 = Math.max(0, Math.floor((b.x - margin - box.x) / step));
      const x1 = Math.min(width - 1, Math.ceil((b.x + b.w + margin - box.x) / step));
      const y0 = Math.max(0, Math.floor((b.y - margin - box.y) / step));
      const y1 = Math.min(height - 1, Math.ceil((b.y + b.h + margin - box.y) / step));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (!affected[i]) { affected[i] = 1; changed.push(i); }
      }
    }
    let committed = false;
    const current = () => {
      if (committed || version !== at) throw new Error('Cannot use stale route clearance trial.');
    };
    return {
      clear(a: Vec2, b: Vec2): boolean {
        current();
        const id = checkId(a, b);
        if (id >= 0) {
          const cached = pending.get(id) ?? accepted[id]!;
          if (pending.has(id) || cached === 1 || cached === 2 && !affected[Math.floor(id / 5)]) return cached === 2;
        }
        const clear = capsule(a, b, radius).every(s => mask.contains(s)
          && !blockers.query(s).some(o => shapesOverlap(s, o)) && !additions.query(s).some(o => shapesOverlap(s, o)));
        if (id >= 0) {
          if (publish) pending.set(id, clear ? 2 : 1); else accepted[id] = clear ? 2 : 1;
        }
        return clear;
      },
      commit() {
        current();
        if (!publish) throw new Error('Only prepared route clearance trials can commit.');
        for (const i of changed) for (let direction = 0; direction < 5; direction++) {
          const id = i * 5 + direction;
          if (accepted[id] === 2) accepted[id] = 0;
        }
        blockers.add(added);
        for (const [id, value] of pending) accepted[id] = value;
        version++;
        committed = true;
      },
    };
  };
  return {
    // Accepted reads are also revision-bound; create a fresh view after each commit.
    accepted: () => trial([], false).clear,
    prepare: (added: readonly Shape[]) => trial(structuredClone(added), true),
  };
}
