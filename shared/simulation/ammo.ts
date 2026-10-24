import { AMMO_FAMILIES, equipped, isAmmoFamily } from '../equipment.ts';
import { allocateItemId } from '../item-instances.ts';
import { planAmmoDrop, scatterPoint } from './loot.ts';
import type { AmmoFamily, Game, GroundItem, Player, PlayerInput, WeaponItem } from '../types.ts';

// L2 reloading (14 "Reloading", #444): weapon-owned magazines, per-player reserves outside the six
// slots and explicit ammo pickups. Every rule here conserves rounds; none creates or deletes any.

/** A carried weapon's reload rule, or undefined without L2 content. */
function reloadRule(s: Game, item: WeaponItem) { return s.content.reloading?.weapons[item.weaponType]; }

/** Rounds a reload of this weapon would load now; 0 without L2 content. */
export function reloadableRounds(s: Game, p: Player, item: WeaponItem): number {
  const rule = reloadRule(s, item);
  return rule && p.reserves ? Math.max(0, Math.min(rule.magazine - item.ammo, p.reserves[rule.family])) : 0;
}

/** Reserve rounds of `family` this player can still take; 0 without L2 content. */
export function reserveRoom(s: Game, p: Player, family: AmmoFamily | undefined): number {
  const capacity = family && s.content.reloading?.reserves[family];
  return capacity && p.reserves ? Math.max(0, capacity - p.reserves[family]) : 0;
}

/**
 * Before identities are assigned: cap each map weapon's rounds at a full magazine and return the
 * rest per weapon. Splitting, not copying, keeps a pickup's rounds from becoming both loaded and reserve.
 */
export function loadMapWeapons(s: Game): Map<GroundItem, number> {
  const rest = new Map<GroundItem, number>(), rules = s.content.reloading;
  if (!rules) return rest;
  for (const item of s.map.items) {
    if (item.kind !== 'weapon') continue;
    const type = item.weaponType ?? 'pistol', spec = s.content.weapons[type], rule = rules.weapons[type];
    if (!spec || !rule) continue;
    const rounds = item.ammo ?? spec.ammo;
    if (!Number.isSafeInteger(rounds) || rounds < 0) continue; // Identity validation refuses it.
    item.ammo = Math.min(rounds, rule.magazine);
    if (rounds > item.ammo) rest.set(item, rounds - item.ammo);
  }
  return rest;
}

/** After identities: each remainder becomes an ammo pickup beside its weapon, and contestants start with empty reserves. */
export function seedAmmo(s: Game, rest: Map<GroundItem, number>): void {
  const rules = s.content.reloading;
  if (!rules) return;
  if (!s.content.itemInstances) throw new RangeError('reloading requires L0 item instances');
  for (const p of s.players) if (p.role === 'contestant') p.reserves = { pistol: 0, rifle: 0, shell: 0 };
  for (const [weapon, count] of rest) {
    const at = scatterPoint(s, weapon, s.itemSerial ?? 0, s.map.items) ?? { x: weapon.x, y: weapon.y };
    const id = allocateItemId(s);
    s.map.items.push({ kind: 'ammo', id, lineageId: id, family: rules.weapons[weapon.weaponType ?? 'pistol'].family, count, x: at.x, y: at.y,
      ...(weapon.buildingId !== undefined ? { buildingId: weapon.buildingId } : {}) });
  }
}

/**
 * Cancel, complete or start this player's reload, after the tick's selection, move and drop and before
 * attack. Cancelling comes first, so a reload interrupted on its last tick transfers nothing.
 */
export function advanceReload(s: Game, p: Player, input: PlayerInput): void {
  if (!s.content.reloading || !p.reserves) return;
  const item = equipped(p), weapon = item?.kind === 'weapon' ? item : null;
  const reload = p.reload;
  if (reload && (p.stun > 0 || p.selectedSlot !== reload.slot || !weapon || weapon.instanceId !== reload.instanceId)) p.reload = null;
  else if (reload && s.tick >= reload.until) {
    const rule = reloadRule(s, weapon!)!;
    const transfer = Math.min(rule.magazine - weapon!.ammo, p.reserves[rule.family]);
    weapon!.ammo += transfer; p.reserves[rule.family] -= transfer; p.reload = null;
    return;
  }
  if (!input.reload || p.reload || p.stun > 0 || !weapon?.instanceId) return;
  const rule = reloadRule(s, weapon);
  if (!rule || weapon.ammo >= rule.magazine || p.reserves[rule.family] <= 0) return;
  p.reload = { slot: p.selectedSlot!, instanceId: weapon.instanceId, until: s.tick + rule.reloadTicks };
}

/** A validated ammo-drop intent: up to `count` reserve rounds of one family as one pickup. */
export function dropReserve(s: Game, p: Player, family: AmmoFamily, count: number, mandatory = false): boolean {
  if (!s.content.reloading || !p.reserves || !isAmmoFamily(family) || !Number.isSafeInteger(count)) return false;
  const rounds = Math.min(count, p.reserves[family]);
  if (rounds <= 0) return false;
  const plan = planAmmoDrop(s, p, family, rounds, mandatory);
  if (!plan) return false;
  s.itemSerial = plan.itemSerial; s.map.items.push(...plan.records);
  p.reserves[family] -= rounds;
  return true;
}

/** Elimination: the reload stops and every reserve family drops as ordinary recoverable loot. */
export function dropReserves(s: Game, p: Player): void {
  p.reload = null;
  if (!s.content.reloading || !p.reserves) return;
  for (const family of AMMO_FAMILIES) dropReserve(s, p, family, p.reserves[family], true);
}
