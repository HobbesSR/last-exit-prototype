import { gatesNear, lineClear } from './movement.ts';
import { distance } from './vector.ts';
import { GATE_REACH } from './simulation/rules.ts';
import type { CollisionMap, Gate, Vec2 } from './types.ts';

/**
 * Which gate a point can reach (22.7): strictly within `GATE_REACH`, with a clear line that ignores
 * only that gate, and accepted by the caller's side-effect-free predicate. `nearest` picks the
 * closest, keeping map order among equal distances; `map` picks the first in map order. Pure: the
 * map and its gate array are left as they were, and the caller does anything to the gate it gets.
 * Only the gates bucketed near the point are tested, in map order, so neither order changes.
 */
export function nearbyGate(map: CollisionMap, point: Vec2, { accepts, order }: { accepts: (gate: Gate) => boolean; order: 'nearest' | 'map' }): Gate | undefined {
  const reachable = (gate: Gate) => distance(point, gate) < GATE_REACH && accepts(gate) && lineClear(map, point, gate, gate.id);
  const near = gatesNear(map, point.x - GATE_REACH, point.y - GATE_REACH, point.x + GATE_REACH, point.y + GATE_REACH);
  if (order === 'map') return near.find(reachable);
  return near.filter(reachable).sort((a, b) => distance(point, a) - distance(point, b))[0];
}
