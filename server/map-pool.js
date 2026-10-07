import { LIVE_ZONE_SIZES, zoneSizeName } from '../map/live.ts';
import { randomSeed } from './protocol.js';

/** Maps kept ready for each size a room can use (#266, 17.4 #10). */
export const MAP_POOL_SIZE = 2;

/**
 * Maps generated ahead of need, so a room that asks for no particular seed opens with its map ready
 * (#266). Each has a fresh random seed. One map is generated at a time, for the size with fewest
 * ready (the default size first on a tie), so refilling uses one worker and never stacks requests.
 * The pool is held in memory only: a restart, which is the only way new generator or content code
 * arrives, starts it empty, so a pooled map is never from another version. A failed generation is
 * reported and refilling pauses until a map is next taken, so a broken generator does not spin.
 */
export function createMapPool({ generate, perSize = MAP_POOL_SIZE, sizes = LIVE_ZONE_SIZES, draw = randomSeed, reportError = console.error }) {
  const ready = new Map(sizes.map(size => [zoneSizeName(size), []]));
  let filling = false, paused = false, closed = false;
  const shortest = () => sizes.filter(size => ready.get(zoneSizeName(size)).length < perSize)
    .reduce((low, size) => !low || ready.get(zoneSizeName(size)).length < ready.get(zoneSizeName(low)).length ? size : low, null);
  function refill() {
    const size = filling || paused || closed ? null : shortest();
    if (!size) return;
    const seed = draw();
    filling = true;
    generate(seed, size).then(
      map => { if (!closed) ready.get(zoneSizeName(size)).push({ seed, map }); },
      error => { if (!closed) { paused = true; reportError(error); } },
    ).finally(() => { filling = false; refill(); });
  }
  refill();
  return {
    /** A ready map of this size and the seed it was generated from, or null when none is ready. */
    take(size) {
      const taken = ready.get(zoneSizeName(size))?.shift() ?? null;
      paused = false; refill();
      return taken;
    },
    /** How many maps are ready, by size name. */
    stock: () => Object.fromEntries([...ready].map(([name, maps]) => [name, maps.length])),
    close() { closed = true; ready.clear(); },
  };
}
