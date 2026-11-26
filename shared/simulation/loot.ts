import { canOccupy } from '../movement.ts';
import { reachClear } from '../sight.ts';
import { allocateItemId, forkItemAllocation } from '../item-instances.ts';
import { scatterInCore } from './boundary.ts';
import { planAmmoInCore } from './phase-three.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { itemsNear } from './ground-items.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import type { AmmoFamily, Game, Player, Vec2 } from '../types.ts';
import type { DropPlan } from './action-records.ts';
import { cos, sin } from '../math.ts';

/**
 * The bounded L0 spiral search: a free, reachable point near `origin`, clear of both lists. A game with a physics world
 * asks the core (`scatterInCore`, #1228), which also keeps the spot clear for a loot body, as the body sync admits
 * one. A record without one (match setup's `seedAmmo`, before `createGame` attaches the world) searches here, where
 * no body needs room. `tests/drop-scatter-core.test.js` holds the core equal to this spiral with that test added.
 */
export function scatterPoint(s: Game, origin: Vec2, phase: number, items: readonly Vec2[], points: readonly Vec2[] = []): Vec2 | undefined {
  const runtime = physicsRuntime(s);
  if (runtime) return scatterInCore(s, runtime, origin, phase, items, points);
  for (let j = 0; j < 180; j++) {
    const angle = (phase + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
    const candidate = { x: origin.x + cos(angle) * radius, y: origin.y + sin(angle) * radius };
    if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, origin, candidate)
      && (items === s.items ? itemsNear(s, candidate, 32) : items).every(other => distance(other, candidate) > 32)
      && points.every(other => distance(other, candidate) > 32)) return candidate;
  }
  return undefined;
}

/** A drop, fully represented but not yet committed. */
export type { DropPlan } from './action-records.ts';

/**
 * One L2 ammo pickup of `count` reserve rounds, planned without changing the match: an optional drop refuses
 * capacity or placement failure, a mandatory one falls back to the player's position.
 */
export function planAmmoDrop(s: Game, p: Player, family: AmmoFamily, count: number, mandatory = false): DropPlan | null {
  if (physicsRuntime(s)) return planAmmoInCore(s, p, family, count, mandatory);
  if (!Number.isSafeInteger(count) || count < 1 || ![p.x, p.y].every(Number.isFinite)) return null;
  if (!mandatory && s.items.length + 1 > s.content.itemInstances.groundCapacity) return null;
  const point = scatterPoint(s, p, s.scatterSerial ?? 0, s.items);
  if (!point && !mandatory) return null;
  const allocation = forkItemAllocation(s);
  try {
    const id = allocateItemId(allocation);
    const at = point ?? { x: p.x, y: p.y };
    return { records: [{ kind: 'ammo', id, lineageId: id, family, count, x: at.x, y: at.y, droppedBy: p.id, pickupAfter: s.tick + HZ }], itemSerial: allocation.itemSerial!, scatterSerial: allocation.scatterSerial!, allocation };
  } catch { return null; }
}
