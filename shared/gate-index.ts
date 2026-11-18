import type { Bounded } from './shape.ts';
import type { Box, CollisionMap, Gate, World } from './types.ts';
import { bucketBox, eachCellIn, Visited } from './buckets.ts';

// Where a map's gates are. Collision (`movement.ts`) and sight (`sight.ts`) both read this one index;
// each decides for itself what an open or closed gate means to it (#1184).

/** A gate's box: centred on its position, with the default door size when it has none. */
export function gateShape(g: Bounded): Box { const w = g.w || 26, h = g.h || 54; return { x: g.x - w / 2, y: g.y - h / 2, w, h }; }

// Gates indexed by their boxes, which never move; whether one is open is read when it is met. Buckets hold
// indices into `map.gates`, so a query can return its gates in map order. A gate list may grow, but is never
// reordered in place: a different order is a different array.
export interface GateIndex { count: number; buckets: Map<string, number[]> }
const gateCache = new WeakMap<Gate[], GateIndex>();
export function gateIndex(map: Pick<CollisionMap, 'gates'>): GateIndex {
  let cached = gateCache.get(map.gates);
  if (cached?.count !== map.gates.length) {
    const buckets = new Map<string, number[]>();
    map.gates.forEach((g, i) => bucketBox(buckets, gateShape(g), i));
    gateCache.set(map.gates, cached = { count: map.gates.length, buckets });
  }
  return cached;
}
const visitedGates = new Visited();
/**
 * The gates, open or closed, whose boxes may touch the closed box from `left`,`top` to `right`,`bottom`,
 * in map order and each once. It may also return gates near the box; the caller makes its exact test.
 */
export function gatesNear(map: Pick<CollisionMap, 'gates'>, left: World, top: World, right: World, bottom: World): Gate[] {
  const found: number[] = [];
  visitedGates.begin(map.gates.length);
  eachCellIn(gateIndex(map).buckets, left, top, right, bottom, list => { for (const i of list) if (visitedGates.first(i)) found.push(i); });
  return found.sort((a, b) => a - b).map(i => map.gates[i]);
}
