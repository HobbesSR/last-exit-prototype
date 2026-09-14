import type { CellItem, InventoryItem, GroundItem, Player, SlotIndex, StackItem, StackKind, WeaponItem, WeaponSpec, WeaponType } from './types.ts';

export const SLOT_COUNT = 6;
/** The weapon table a match is pinned to. Defaults below; a match passes its own copy. */
type WeaponTable = Record<WeaponType, WeaponSpec>;
export const WEAPONS: Record<WeaponType, WeaponSpec> = {
  pistol: { name: 'Pistol', ammo: 48, maxAmmo: 192, cooldown: 8, damage: 10, speed: 35, life: 24, spread: [0] },
  rifle: { name: 'Rifle', ammo: 90, maxAmmo: 360, cooldown: 4, damage: 6, speed: 44, life: 28, spread: [0] },
  scattergun: { name: 'Scattergun', ammo: 24, maxAmmo: 96, cooldown: 18, damage: 7, speed: 30, life: 12, spread: [-0.18, -0.09, 0, 0.09, 0.18] }
};
export function equipped(p: Player): InventoryItem | null { return p.inventory?.[p.selectedSlot || 0] || null; }
export function carriedCell(p: Player): CellItem | null { return equipped(p)?.kind === 'cell' ? equipped(p) as CellItem : p.inventory?.find((item): item is CellItem => item?.kind === 'cell') || null; }
export function syncWeapon(p: Player, weapons: WeaponTable = WEAPONS): void {
  const item = equipped(p);
  p.weapon = item?.kind === 'weapon' ? Object.keys(weapons).indexOf(item.weaponType) + 1 : 0;
}
export function collectEquipment(p: Player, item: GroundItem, weapons: WeaponTable = WEAPONS): boolean {
  const inventory = p.inventory;
  if (!inventory) return false;
  if (item.kind === 'weapon') {
    const type = item.weaponType || 'pistol', weapon = weapons[type];
    if (!weapon) return false;
    const existing = inventory.find((slot): slot is WeaponItem => slot?.kind === 'weapon' && slot.weaponType === type);
    if (existing) {
      existing.ammo ??= weapon.ammo;
      const incoming = item.ammo ?? weapon.ammo;
      const transfer = Math.min(incoming, weapon.maxAmmo - existing.ammo);
      if (transfer <= 0) return false;
      existing.ammo += transfer; item.ammo = incoming - transfer;
      return item.ammo === 0; // A partly used weapon pickup remains on the ground.
    }
  } else if (item.kind !== 'cell') {
    const stack = inventory.find((slot): slot is StackItem => (slot?.kind === 'med' || slot?.kind === 'shield') && slot.kind === item.kind && slot.count < 3);
    if (stack) { stack.count++; return true; }
  }
  const index = inventory.findIndex(slot => !slot);
  if (index < 0) return false;
  inventory[index] = item.kind === 'weapon' ? { kind: 'weapon', weaponType: item.weaponType || 'pistol', ammo: item.ammo ?? weapons[item.weaponType || 'pistol'].ammo }
    // Callers only offer carried kinds; an `access` charge is banked in `Player.keys` instead.
    : item.kind === 'cell' ? { kind: 'cell', charge: item.charge || 0 } : { kind: item.kind as StackKind, count: 1 };
  if (!equipped(p) || item.kind === 'weapon' && equipped(p)!.kind !== 'weapon') p.selectedSlot = index;
  syncWeapon(p, weapons); return true;
}

export function rearrangeEquipment(p: Player, from: SlotIndex, to: SlotIndex, weapons: WeaponTable = WEAPONS): boolean {
  if (!p.inventory || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= p.inventory.length || to >= p.inventory.length || from === to) return false;
  const source = p.inventory[from], target = p.inventory[to];
  if (!source) return false;
  if (target && (source.kind === 'med' || source.kind === 'shield') && (target.kind === 'med' || target.kind === 'shield') && target.kind === source.kind) {
    const transfer = Math.min(source.count, 3 - target.count);
    if (transfer <= 0) return false;
    target.count += transfer; source.count -= transfer;
    if (!source.count) { p.inventory[from] = null; if (p.selectedSlot === from) p.selectedSlot = to; }
  } else {
    [p.inventory[from], p.inventory[to]] = [target, source];
    if (p.selectedSlot === from) p.selectedSlot = to;
    else if (p.selectedSlot === to) p.selectedSlot = from;
  }
  syncWeapon(p, weapons); return true;
}
