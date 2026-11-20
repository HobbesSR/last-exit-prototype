import type { Game, GroundItem, InventoryItem, ItemId, ItemLabel } from './types.ts';

const validId = (id: unknown): id is ItemId => Number.isSafeInteger(id) && (id as number) > 0;
const validQuality = (quality: unknown): boolean => quality === undefined || Number.isInteger(quality) && (quality as number) >= 1 && (quality as number) <= 5;
const validCount = (count: unknown): boolean => Number.isSafeInteger(count) && (count as number) > 0;

export function validateItemPayload(item: GroundItem | InventoryItem, s: Game): boolean {
  if (!validQuality(item.quality) || item.instanceId !== undefined && !validId(item.instanceId) || item.lineageId !== undefined && !validId(item.lineageId)) return false;
  if (item.kind === 'weapon') {
    const type = item.weaponType ?? 'pistol';
    if (!Object.hasOwn(s.content.weapons, type)) return false;
    const spec = s.content.weapons[type];
    const ammo = item.ammo ?? spec?.ammo;
    // Under L2 a weapon's rounds are its loaded magazine.
    const limit = s.content.reloading?.weapons[type]?.magazine ?? spec?.maxAmmo;
    return !!spec && Number.isSafeInteger(ammo) && ammo >= 0 && ammo <= limit!;
  }
  if (item.kind === 'ammo') {
    const family = 'family' in item ? item.family : undefined;
    return 'id' in item && !!s.content.reloading && typeof family === 'string' && Object.hasOwn(s.content.reloading.reserves, family) && validCount(item.count);
  }
  if (item.kind === 'cell') return Number.isSafeInteger(item.charge ?? 0) && (item.charge ?? 0) >= 0;
  if (item.kind === 'med' || item.kind === 'shield') {
    const count = item.count ?? ('id' in item ? 1 : undefined);
    return validCount(count) && ('id' in item || (count as number) <= 3);
  }
  return item.kind === 'access' && 'id' in item;
}

/** Labels are compatibility metadata, never runtime lookup keys. Forks hold only tentative additions. */
export interface ItemRegistry {
  ids: Map<string, ItemId>;
  labels: Map<ItemId, ItemLabel>;
  parent?: ItemRegistry | undefined;
}
const registry = (s: Game): ItemRegistry => s.itemIdentities ??= { ids: new Map(), labels: new Map() };
function lookup<K, V>(r: ItemRegistry | undefined, field: 'ids' | 'labels', key: K): V | undefined {
  for (; r; r = r.parent) {
    const value = (r[field] as Map<K, V>).get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}
export const itemIdForLabel = (s: Game, label: string): ItemId | undefined => lookup(s.itemIdentities, 'ids', label);
export function itemLabel(s: Game, id: ItemId): ItemLabel {
  const label = lookup<ItemId, ItemLabel>(s.itemIdentities, 'labels', id);
  if (label === undefined) throw new Error(`Unregistered item identity ${id}`);
  return label;
}
/** Explicit match-load/scenario registration; registering metadata consumes no scatter phase. */
export function registerItemLabel(s: Game, label: string): ItemId {
  if (typeof label !== 'string' || !label.length) throw new Error('Invalid item label');
  const existing = itemIdForLabel(s, label);
  if (existing !== undefined) return existing;
  const next = s.itemSerial ?? 1;
  if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
  const id = next as ItemId, r = registry(s);
  r.ids.set(label, id); r.labels.set(id, label as ItemLabel); s.itemSerial = next + 1;
  return id;
}
/** Copy-on-write identity transaction. Discarding this game discards all new labels and both counters. */
export function forkItemAllocation(s: Game): Game {
  return { ...s, itemIdentities: { ids: new Map(), labels: new Map(), parent: registry(s) } };
}
/** Publish only additions owned by this transaction, including a staged pickup's parent transaction. */
export function commitItemAllocation(s: Game, stage: Game): void {
  const target = registry(s), layers: ItemRegistry[] = [];
  for (let r = stage.itemIdentities; r && r !== target; r = r.parent) layers.push(r);
  for (const layer of layers.reverse()) {
    for (const [label, id] of layer.ids) target.ids.set(label, id);
    for (const [id, label] of layer.labels) target.labels.set(id, label);
  }
  s.itemSerial = stage.itemSerial; s.scatterSerial = stage.scatterSerial;
}
/** One monotonic numeric domain; legacy allocation labels preserve the independent scatter schedule. */
export function allocateItemId(s: Game): ItemId {
  let scatter = s.scatterSerial ?? 0;
  if (!Number.isSafeInteger(scatter) || scatter < 0) throw new Error('Invalid item scatter counter');
  // Reachable identities and roots precede persisted scatter. Reserved labels need no live-item scan.
  while (true) {
    if (scatter >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
    const label = `instance-${scatter++}`;
    if (itemIdForLabel(s, label) !== undefined) continue;
    const id = registerItemLabel(s, label);
    s.scatterSerial = scatter;
    return id;
  }
}
export function ensureItemIdentity(s: Game, item: InventoryItem): void {
  if (!validQuality(item.quality) || item.instanceId !== undefined && !validId(item.instanceId) || item.lineageId !== undefined && !validId(item.lineageId)) throw new Error('Invalid carried item identity');
  item.instanceId ??= allocateItemId(s);
  item.lineageId ??= item.instanceId;
  itemLabel(s, item.instanceId); itemLabel(s, item.lineageId);
}
/** Match-load normalization. Original artifact labels and disappeared lineage roots remain registered. */
export function initializeItemInstances(s: Game): void {
  const capacity = s.content.itemInstances.groundCapacity;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || s.items.length > capacity
    || s.itemSerial !== undefined && (!Number.isSafeInteger(s.itemSerial) || s.itemSerial < 0)
    || s.scatterSerial !== undefined && (!Number.isSafeInteger(s.scatterSerial) || s.scatterSerial < 0)) throw new Error('Invalid item instance configuration');
  // At this one input boundary records can still carry artifact labels. Validate before mutating them.
  const all = [...s.items, ...s.players.flatMap(p => p.inventory?.filter(i => i !== null) ?? [])];
  const reloads = s.players.flatMap(p => p.reload ? [p.reload] : []);
  const used = new Set<unknown>();
  const inputId = (id: unknown) => typeof id === 'string' && id.length > 0 || validId(id);
  let legacyNext = s.itemIdentities ? s.scatterSerial ?? 0 : s.itemSerial ?? 0;
  let numericNext = s.itemIdentities ? s.itemSerial ?? 1 : 1;
  for (const item of all) {
    const ground = 'id' in item, id = ground ? item.id : item.instanceId;
    const key = typeof id === 'number' ? itemLabel(s, id) : id;
    if (ground && !inputId(id) || id !== undefined && (!inputId(id) || used.has(key))
      || ground && item.instanceId !== undefined && item.instanceId !== id
      || item.lineageId !== undefined && !inputId(item.lineageId)) throw new Error(ground ? 'Invalid ground item' : 'Invalid carried item');
    if (id !== undefined) used.add(key);
    // Payload validation does not interpret input identities until they have been normalized.
    if (!validateItemPayload({ ...item, instanceId: undefined, lineageId: undefined }, s)) throw new Error('Invalid item payload');
    for (const value of [id, item.instanceId, item.lineageId]) {
      if (typeof value === 'number') {
        if (value >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
        numericNext = Math.max(numericNext, value + 1);
        itemLabel(s, value);
      }
      const label = typeof value === 'number' ? itemLabel(s, value) : value;
      // Only active legacy identities reserved scatter phases; lineage metadata does not.
      if (value === id && typeof label === 'string') {
        const match = /^instance-(0|[1-9]\d*)$/.exec(label);
        if (match) {
          const n = Number(match[1]);
          if (!Number.isSafeInteger(n) || n >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
          legacyNext = Math.max(legacyNext, n + 1);
        }
      }
    }
  }
  for (const reload of reloads) {
    const id = reload.instanceId;
    if (!inputId(id)) throw new Error('Invalid reload item identity');
    if (typeof id === 'number') {
      if (id >= Number.MAX_SAFE_INTEGER) throw new Error('Item instance counter exhausted');
      itemLabel(s, id);
      numericNext = Math.max(numericNext, id + 1);
    }
  }
  s.itemSerial = numericNext;
  registry(s);
  const normalize = (id: ItemId): ItemId => typeof id === 'string' ? registerItemLabel(s, id) : id;
  for (const item of all) {
    if ('id' in item) item.id = normalize(item.id);
    if (item.instanceId !== undefined) item.instanceId = normalize(item.instanceId);
    if (item.lineageId !== undefined) item.lineageId = normalize(item.lineageId);
  }
  for (const reload of reloads) reload.instanceId = normalize(reload.instanceId);
  s.scatterSerial ??= legacyNext;
  const players = [...s.players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const player of players) {
    for (const item of player.inventory ?? []) if (item) ensureItemIdentity(s, item);
  }
}
