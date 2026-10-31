import { bounds, type Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { RegionMask } from './types.ts';
import { capsule, shapesOverlap } from './geometry.ts';

type Entry = { clear: boolean; version: number; swept: Shape[] };
type Blocker = { shape: Shape; version: number };

/** One immutable access mask/body/door policy and a monotonically growing collision prefix.
 * The caller must keep the mask unchanged; supply door colliders according to its policy.
 * Geometry is copied. No state is shared between factories, including equal-looking masks.
 */
export function createRouteClearance(mask: RegionMask, initial: readonly Shape[], radius: number) {
  const size = mask.cellSize * 4;
  const keys = (shape: Shape): string[] => {
    const b = bounds(shape), result: string[] = [];
    for (let y = Math.floor(b.y / size); y <= Math.floor((b.y + b.h) / size); y++)
      for (let x = Math.floor(b.x / size); x <= Math.floor((b.x + b.w) / size); x++) result.push(`${x},${y}`);
    return result;
  };
  const buckets = new Map<string, Blocker[]>();
  const add = (shapes: readonly Shape[], version: number) => {
    for (const shape of shapes) for (const key of keys(shape)) {
      const bucket = buckets.get(key);
      const item = { shape, version };
      if (bucket) bucket.push(item); else buckets.set(key, [item]);
    }
  };
  add(structuredClone(initial), 0);
  let version = 0;
  const accepted = new Map<string, Entry>();
  const trial = (added: readonly Shape[], publish: boolean) => {
    const at = version, next = at + (publish ? 1 : 0);
    const pending = new Map<string, Entry>();
    let committed = false;
    const current = () => {
      if (committed || version !== at) throw new Error('Cannot use stale route clearance trial.');
    };
    return {
      clear(a: Vec2, b: Vec2): boolean {
        current();
        const key = `${a.x},${a.y}:${b.x},${b.y}`;
        const prior = pending.get(key) ?? accepted.get(key);
        if (prior && (!prior.clear || prior.version === next)) return prior.clear;
        const swept = prior?.swept ?? capsule(a, b, radius);
        const clear = swept.every(s => {
          // A previously clear capsule already fits the same immutable mask.
          if (!prior && !mask.contains(s)) return false;
          const seen = new Set<Shape>();
          for (const key of keys(s)) for (const item of buckets.get(key) ?? []) {
            if (prior && item.version <= prior.version || seen.has(item.shape)) continue;
            seen.add(item.shape);
            if (shapesOverlap(s, item.shape)) return false;
          }
          return !added.some(shape => shapesOverlap(s, shape));
        });
        const entry = { clear, version: next, swept };
        (publish ? pending : accepted).set(key, entry);
        return clear;
      },
      commit() {
        current();
        if (!publish) throw new Error('Only prepared route clearance trials can commit.');
        add(added, next);
        for (const [key, entry] of pending) accepted.set(key, entry);
        version = next;
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
