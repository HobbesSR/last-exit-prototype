import { defaultContent } from './simulation/content.ts';
import type { CellItem, Game, InventoryItem, GroundItem, Player, SlotIndex, StackItem, StackKind, WeaponItem, WeaponSpec, WeaponType } from './types.ts';
import { allocateItemId, ensureItemIdentity, validateItemPayload } from './item-instances.ts';

export const SLOT_COUNT = 6;
/** The weapon table a match is pinned to. Defaults below; a match passes its own copy. */
type WeaponTable = Record<WeaponType, WeaponSpec>;
// A detached copy of the shipped weapons for callers without a match (22.7). Editing it changes no
// content set and no match; a match passes its own pinned table.
export const WEAPONS: Record<WeaponType, WeaponSpec> = structuredClone(defaultContent().weapons);
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

const qualityOf = (item: { quality?: number | undefined }): number => item.quality ?? 1;
/** Only equal qualities merge or refill; omitted quality means 1 (14). */
export const sameQuality = (a: { quality?: number | undefined }, b: { quality?: number | undefined }): boolean => qualityOf(a) === qualityOf(b);
const stackKind = (kind: string): kind is StackKind => kind === 'med' || kind === 'shield';
const validIdentityState = (s: Game, p: Player, ground?: GroundItem): boolean => {
  const capacity = s.content.itemInstances?.groundCapacity;
  if (!Number.isSafeInteger(capacity) || capacity! < 0 || !Number.isSafeInteger(s.itemSerial) || s.itemSerial! < 0 || !p.inventory || p.inventory.length !== SLOT_COUNT) return false;
  const ids = new Set<string>();
  if (ground) {
    if (!s.map.items.includes(ground) || typeof ground.id !== 'string' || !ground.id || ground.instanceId !== undefined && ground.instanceId !== ground.id || !validateItemPayload(ground, s)) return false;
    ids.add(ground.id);
  }
  for (const item of p.inventory) {
    if (!item) continue;
    if (!validateItemPayload(item, s) || item.instanceId && ids.has(item.instanceId)) return false;
    if (item.instanceId) ids.add(item.instanceId);
  }
  return true;
};
const prepareCarried = (s: Game, p: Player): void => {
  for (const item of p.inventory ?? []) if (item) ensureItemIdentity(s, item);
};

/** Opt-in L0 transfer. True means the caller may remove the whole ground instance. */
export function collectInstanceEquipment(s: Game, p: Player, item: GroundItem): boolean {
  if (!validIdentityState(s, p, item) || item.kind === 'access') return false;
  const inventory = p.inventory!;
  const root = item.lineageId ?? item.id;
  if (item.kind === 'weapon') {
    const type = item.weaponType ?? 'pistol', weapon = s.content.weapons[type];
    const existing = inventory.find((slot): slot is WeaponItem => slot?.kind === 'weapon' && slot.weaponType === type && sameQuality(slot, item));
    if (existing) {
      const current = existing.ammo ?? weapon.ammo, incoming = item.ammo ?? weapon.ammo;
      const transfer = Math.min(incoming, weapon.maxAmmo - current);
      if (transfer <= 0) return false;
      prepareCarried(s, p);
      existing.ammo = current + transfer;
      item.ammo = incoming - transfer;
      return item.ammo === 0;
    }
  } else if (stackKind(item.kind)) {
    const target = inventory.find((slot): slot is StackItem => !!slot && stackKind(slot.kind) && slot.kind === item.kind && sameQuality(slot, item) && (slot as StackItem).count < 3);
    if (target) {
      const count = item.count ?? 1, transfer = Math.min(count, 3 - target.count);
      prepareCarried(s, p);
      target.count += transfer;
      if (transfer === count) return true;
      item.count = count - transfer;
      return false;
    }
  }
  const index = inventory.findIndex(slot => !slot);
  if (index < 0) return false;
  const count = stackKind(item.kind) ? item.count ?? 1 : 1;
  const taken = Math.min(count, 3);
  prepareCarried(s, p);
  const id = taken < count ? allocateItemId(s) : item.id;
  const identity = { instanceId: id, lineageId: root, ...(item.quality === undefined ? {} : { quality: item.quality }) };
  inventory[index] = item.kind === 'weapon'
    ? { kind: 'weapon', weaponType: item.weaponType ?? 'pistol', ammo: item.ammo ?? s.content.weapons[item.weaponType ?? 'pistol'].ammo, ...identity }
    : item.kind === 'cell'
      ? { kind: 'cell', charge: item.charge ?? 0, ...identity }
      : { kind: item.kind as StackKind, count: taken, ...identity };
  if (taken < count) item.count = count - taken;
  if (!equipped(p) || item.kind === 'weapon' && equipped(p)!.kind !== 'weapon') p.selectedSlot = index;
  syncWeapon(p, s.content.weapons);
  return taken === count;
}

/** Opt-in L0 rearrangement; the target stack survives a same-quality merge. */
export function rearrangeInstanceEquipment(s: Game, p: Player, from: SlotIndex, to: SlotIndex): boolean {
  if (!validIdentityState(s, p) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= SLOT_COUNT || to >= SLOT_COUNT || from === to) return false;
  const source = p.inventory![from], target = p.inventory![to];
  if (!source) return false;
  if (target && stackKind(source.kind) && stackKind(target.kind) && source.kind === target.kind && sameQuality(source, target)) {
    const stackSource = source as StackItem, stackTarget = target as StackItem;
    const transfer = Math.min(stackSource.count, 3 - stackTarget.count);
    if (transfer <= 0) return false;
    prepareCarried(s, p);
    stackTarget.count += transfer;
    stackSource.count -= transfer;
    if (!stackSource.count) { p.inventory![from] = null; if (p.selectedSlot === from) p.selectedSlot = to; }
  } else {
    prepareCarried(s, p);
    [p.inventory![from], p.inventory![to]] = [target, source];
    if (p.selectedSlot === from) p.selectedSlot = to;
    else if (p.selectedSlot === to) p.selectedSlot = from;
  }
  syncWeapon(p, s.content.weapons);
  return true;
}
