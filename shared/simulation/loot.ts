import { canOccupy } from '../movement.ts';
import { reachClear } from '../sight.ts';
import { syncWeapon } from '../equipment.ts';
import { allocateItemId, ensureItemIdentity, validateItemPayload, forkItemAllocation, commitItemAllocation } from '../item-instances.ts';
import { canRepresentPhysicalDrop, launchPhysicalDrops } from './world-physics.ts';
import { scatterInCore } from './boundary.ts';
import { planDropInCore, planAmmoInCore } from './phase-three.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { addItems, itemsNear } from './ground-items.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import type { AmmoFamily, Game, GroundItem, InventoryItem, Player, PlayerInput, Vec2 } from '../types.ts';
import { phaseSix, STEP_PICKUPS } from './phase-six.ts';
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

/** An L0 drop, fully represented but not yet committed. */
export type { DropPlan } from './action-records.ts';

/**
 * Validate, place and identify every ground record of one carried L0 item without changing the
 * match. `items` stands in for the ground list, so a swap can plan around the pickup it removes.
 */
export function planDrop(s: Game, p: Player, item: InventoryItem, mandatory = false, items: readonly GroundItem[] = s.items,
  source: Game = s): DropPlan | null {
  if (physicsRuntime(s)) return planDropInCore(s, p, item, mandatory, items, source);
  if (!['weapon', 'med', 'shield', 'cell'].includes(item.kind) || ![p.x, p.y].every(Number.isFinite) || !validateItemPayload(item, s)) return null;
  const copies = item.kind === 'med' || item.kind === 'shield' ? item.count : 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 3
    || item.kind === 'weapon' && (!Number.isSafeInteger(item.ammo) || item.ammo < 0)
    || item.kind === 'cell' && (!Number.isSafeInteger(item.charge) || item.charge < 0)) return null;
  if (!mandatory && items.length + copies > s.content.itemInstances.groundCapacity) return null;
  const points: Vec2[] = [];
  for (let i = 0; i < copies; i++) {
    const point = scatterPoint(s, p, (source.scatterSerial ?? 0) + i, items, points);
    if (!point && !mandatory) return null;
    // Mandatory overflow is logical loot, not a promise that the physics world can allocate a body here.
    points.push(point ?? { x: p.x, y: p.y });
  }
  if (item.instanceId && (items.some(other => other.id === item.instanceId)
    || s.players.some(player => player.inventory?.some(other => other && other !== item && other.instanceId === item.instanceId)))) return null;
  // Allocation is staged too: an exhausted counter cannot partly split a carried stack.
  const allocation = forkItemAllocation(source), identity = { ...item };
  try {
    ensureItemIdentity(allocation, identity);
    const records = points.map((point, i): GroundItem => ({
      kind: item.kind, id: i ? allocateItemId(allocation) : identity.instanceId!, lineageId: identity.lineageId,
      ...(item.quality !== undefined ? { quality: item.quality } : {}),
      ...(item.kind === 'weapon' ? { weaponType: item.weaponType, ammo: item.ammo }
        : item.kind === 'cell' ? { charge: item.charge } : { count: 1 }),
      ...point, droppedBy: p.id, pickupAfter: s.tick + HZ,
    }));
    return { records, itemSerial: allocation.itemSerial!, scatterSerial: allocation.scatterSerial!, allocation };
  } catch { return null; }
}

/**
 * One L2 ammo pickup of `count` reserve rounds, planned like `planDrop`: an optional drop refuses
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

/** Drop one slot; optional drops commit only a complete plan and may refuse. */
export function dropInventorySlot(s: Game, p: Player, slot: number, mandatory = false): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= (p.inventory?.length ?? 0)) return false;
  const item = p.inventory![slot];
  if (!item) return false;
  const plan = planDrop(s, p, item, mandatory);
  if (!plan || !mandatory && !canRepresentPhysicalDrop(s, plan.records.length)) return false;
  commitItemAllocation(s, plan.allocation);
  addItems(s, ...plan.records);
  p.inventory![slot] = null; p.charging = null; syncWeapon(p, s.content.weapons);
  if (plan.records.length) launchPhysicalDrops(s, plan.records, p);
  return true;
}
/**
 * A contestant's automatic pickups within reach, then the sensors' reveal. It runs in the core (`rust/core/src/phase_six.rs`,
 * #1230), each record taken whole at 5c.2's sync boundary; this is its entry for scenarios.
 */
export function automaticPickups(s: Game, p: Player, input: PlayerInput): void {
  phaseSix(s, [{ player: p, steps: STEP_PICKUPS, sneak: !!input.sneak }], false);
}
