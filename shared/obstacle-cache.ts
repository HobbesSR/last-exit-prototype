import type { CollisionMap, Obstacle } from './types.ts';

// A per-map index built from the obstacle list, built on demand or prepared ahead in batches. Collision
// (`movement.ts`) and sight (`sight.ts`) each keep one, so each owns its own index (#1184).
//
// Keyed by the obstacle list, not the map: maps that differ only in gates, such as a contestant's remembered
// doors, share one index instead of rebuilding it (#727). A cached index is
// stale once the list grows, so its `count` is checked against the list's length.

/** Builders count work rather than reading a clock: this path also runs in the portable simulation. */
export const PREPARATION_CHUNK = 128;

export interface ObstacleCache<T> {
  /** The map's index, built synchronously if it is not cached. */
  get(map: Pick<CollisionMap, 'obstacles'>): T;
  /** Prepare the same index `get` builds, yielding between bounded batches. Only a complete build is
   * published; a query or another preparation may safely finish its own meanwhile. A rejected callback
   * leaves no partial cache. Obstacle-list replacement/growth during a yield restarts preparation with
   * the current list, preserving the synchronous cache's identity/length key. */
  prepare(map: Pick<CollisionMap, 'obstacles'>, yieldControl: () => Promise<void>): Promise<void>;
}

/** `build` yields after each bounded batch of work and returns the index with the list length it covers. */
export function obstacleCache<T extends { count: number }>(build: (obstacles: readonly Obstacle[]) => Generator<void, T>): ObstacleCache<T> {
  const cache = new WeakMap<readonly Obstacle[], T>();
  return {
    get(map) {
      const cached = cache.get(map.obstacles);
      if (cached && cached.count === map.obstacles.length) return cached;
      const run = build(map.obstacles);
      let next = run.next();
      while (!next.done) next = run.next();
      cache.set(map.obstacles, next.value);
      return next.value;
    },
    async prepare(map, yieldControl) {
      for (;;) {
        const obstacles = map.obstacles, cached = cache.get(obstacles);
        if (cached && cached.count === obstacles.length) return;
        const run = build(obstacles), count = obstacles.length;
        let next = run.next();
        while (!next.done) {
          await yieldControl();
          if (map.obstacles !== obstacles || obstacles.length !== count) break;
          next = run.next();
        }
        if (!next.done) continue;
        cache.set(obstacles, next.value);
        return;
      }
    },
  };
}
