import { defaultContent } from './simulation/content.ts';
import { AMMO_FAMILIES as AMMO_ORDER, WEAPONS as WEAPON_ORDER } from './enum-tables.ts';
import type { AmmoFamily, CellItem, InventoryItem, Player, WeaponSpec, WeaponType } from './types.ts';

export const SLOT_COUNT = 6;
/** L2 reserve families, in their fixed drop and display order. */
export const AMMO_FAMILIES: readonly AmmoFamily[] = AMMO_ORDER;
export const isAmmoFamily = (value: unknown): value is AmmoFamily => AMMO_FAMILIES.includes(value as AmmoFamily);
/** The weapon table a match is pinned to. Defaults below; a match passes its own copy. */
type WeaponTable = Record<WeaponType, WeaponSpec>;
// A detached copy of the shipped weapons for callers without a match (22.7). Editing it changes no
// content set and no match; a match passes its own pinned table.
export const WEAPONS: Record<WeaponType, WeaponSpec> = structuredClone(defaultContent().weapons);
export function equipped(p: Player): InventoryItem | null { return p.inventory?.[p.selectedSlot || 0] || null; }
export function carriedCell(p: Player): CellItem | null { return equipped(p)?.kind === 'cell' ? equipped(p) as CellItem : p.inventory?.find((item): item is CellItem => item?.kind === 'cell') || null; }
export function syncWeapon(p: Player, weapons: WeaponTable = WEAPONS): void {
  const item = equipped(p);
  p.weapon = item?.kind === 'weapon' && Object.hasOwn(weapons, item.weaponType) ? WEAPON_ORDER.indexOf(item.weaponType) + 1 : 0;
}

const qualityOf = (item: { quality?: number | undefined }): number => item.quality ?? 1;
/** Only equal qualities merge or refill; omitted quality means 1 (14). */
export const sameQuality = (a: { quality?: number | undefined }, b: { quality?: number | undefined }): boolean => qualityOf(a) === qualityOf(b);
