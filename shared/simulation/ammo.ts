import { allocateItemId } from '../item-instances.ts';
import { scatterPoint } from './loot.ts';
import { addItems } from './ground-items.ts';
import type { Game, GroundItem } from '../types.ts';

// L2 reloading (14 "Reloading", #444): weapon-owned magazines, per-player reserves outside the six
// slots and explicit ammo pickups. Every rule here conserves rounds; none creates or deletes any.

/**
 * Before identities are assigned: cap each map weapon's rounds at a full magazine and return the
 * rest per weapon. Splitting, not copying, keeps a pickup's rounds from becoming both loaded and reserve.
 */
export function loadMapWeapons(s: Game): Map<GroundItem, number> {
  const rest = new Map<GroundItem, number>(), rules = s.content.reloading;
  if (!rules) return rest;
  for (const item of s.items) {
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
  for (const p of s.players) if (p.role === 'contestant') p.reserves = { pistol: 0, rifle: 0, shell: 0 };
  for (const [weapon, count] of rest) {
    const at = scatterPoint(s, weapon, s.scatterSerial ?? 0, s.items) ?? { x: weapon.x, y: weapon.y };
    const id = allocateItemId(s);
    addItems(s, { kind: 'ammo', id, lineageId: id, family: rules.weapons[weapon.weaponType ?? 'pistol'].family, count, x: at.x, y: at.y,
      ...(weapon.buildingId !== undefined ? { buildingId: weapon.buildingId } : {}) });
  }
}
