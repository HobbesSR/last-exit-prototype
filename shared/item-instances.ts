import type { Game, GroundItem, InventoryItem, ItemId } from './types.ts';

const validId = (id: unknown): id is ItemId => typeof id === 'string' && id.length > 0;
const validQuality = (quality: unknown): boolean => quality === undefined || Number.isInteger(quality) && (quality as number) >= 1 && (quality as number) <= 5;
const validCount = (count: unknown): boolean => Number.isSafeInteger(count) && (count as number) > 0;

export function validateItemPayload(item: GroundItem | InventoryItem, s: Game): boolean {
  if (!validQuality(item.quality) || item.instanceId !== undefined && !validId(item.instanceId) || item.lineageId !== undefined && !validId(item.lineageId)) return false;
  if (item.kind === 'weapon') {
    const type = item.weaponType ?? 'pistol';
    if (!Object.hasOwn(s.content.weapons, type)) return false;
    const spec = s.content.weapons[type];
    const ammo = item.ammo ?? spec?.ammo;
    return !!spec && Number.isSafeInteger(ammo) && ammo >= 0 && ammo <= spec.maxAmmo;
  }
  if (item.kind === 'cell') return Number.isSafeInteger(item.charge ?? 0) && (item.charge ?? 0) >= 0;
  if (item.kind === 'med' || item.kind === 'shield') {
    const count = item.count ?? ('id' in item ? 1 : undefined);
    return validCount(count) && ('id' in item || (count as number) <= 3);
  }
  return item.kind === 'access' && 'id' in item;
}

/** Uses a counter independent of simulation RNG and event IDs. */
export function allocateItemId(s: Game): ItemId {
  if (!s.content.itemInstances || !Number.isSafeInteger(s.itemSerial) || s.itemSerial! < 0) throw new Error('Invalid item instance counter');
  const used = new Set<string>();
  for (const item of s.map.items) { if (validId(item.id)) used.add(item.id); if (validId(item.instanceId)) used.add(item.instanceId); }
  for (const player of s.players) for (const item of player.inventory ?? []) if (item && validId(item.instanceId)) used.add(item.instanceId);
  while (true) {
    if (!Number.isSafeInteger(s.itemSerial) || s.itemSerial! >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
    const id = `instance-${s.itemSerial!++}` as ItemId;
    if (!used.has(id)) return id;
  }
}

export function ensureItemIdentity(s: Game, item: InventoryItem): void {
  if (!validQuality(item.quality) || item.instanceId !== undefined && !validId(item.instanceId) || item.lineageId !== undefined && !validId(item.lineageId)) throw new Error('Invalid carried item identity');
  item.instanceId ??= allocateItemId(s);
  item.lineageId ??= item.instanceId;
}

/** Validate first, then assign legacy carried IDs in player and slot order. */
export function initializeItemInstances(s: Game): void {
  const capacity = s.content.itemInstances?.groundCapacity;
  if (!Number.isSafeInteger(capacity) || capacity! < 0 || s.map.items.length > capacity! || s.itemSerial !== undefined && (!Number.isSafeInteger(s.itemSerial) || s.itemSerial < 0)) throw new Error('Invalid item instance configuration');
  const used = new Set<string>();
  for (const item of s.map.items) {
    if (!validId(item.id) || item.instanceId !== undefined && item.instanceId !== item.id || !validateItemPayload(item, s) || used.has(item.id)) throw new Error('Invalid ground item');
    used.add(item.id);
  }
  for (const player of s.players) for (const item of player.inventory ?? []) {
    if (!item) continue;
    if (!validateItemPayload(item, s) || item.instanceId && used.has(item.instanceId)) throw new Error('Invalid carried item');
    if (item.instanceId) used.add(item.instanceId);
  }
  // Initial IDs may already occupy our allocation namespace. Reserve their numbers forever,
  // including after the original item is consumed and disappears from the live state.
  let next = s.itemSerial ?? 0;
  for (const id of used) {
    const match = /^instance-(0|[1-9]\d*)$/.exec(id);
    if (!match) continue;
    const serial = Number(match[1]);
    if (!Number.isSafeInteger(serial) || serial >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
    next = Math.max(next, serial + 1);
  }
  const missing = s.players.reduce((total, player) => total + (player.inventory ?? []).filter(item => item && !item.instanceId).length, 0);
  if (missing > Number.MAX_SAFE_INTEGER - next) throw new Error('Item instance counter exhausted');
  s.itemSerial = next;
  const players = [...s.players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const player of players) for (const item of player.inventory ?? []) if (item) ensureItemIdentity(s, item);
}
