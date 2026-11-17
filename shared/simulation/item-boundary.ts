import { itemLabel } from '../item-instances.ts';
import { framedItems, shareItemPublication } from './ground-items.ts';
import type { Game, GroundItem, InventoryItem, ItemLabel, Player, Vec2 } from '../types.ts';

// CP1 adapter (24.4): runtime records keep numeric relations; immutable legacy records/lists
// are converted once and shared by snapshots, projections and the recording serializer.
const records = new WeakMap<GroundItem, GroundItem<ItemLabel>>();
const lists = new WeakMap<readonly GroundItem[], GroundItem<ItemLabel>[]>();
const sources = new WeakMap<readonly GroundItem<ItemLabel>[], readonly GroundItem[]>();

function legacyGround(s: Game, item: GroundItem): GroundItem<ItemLabel> {
  let legacy = Object.isFrozen(item) ? records.get(item) : undefined;
  if (!legacy) {
    legacy = { ...item, id: itemLabel(s, item.id),
      ...(item.instanceId !== undefined ? { instanceId: itemLabel(s, item.instanceId) } : {}),
      ...(item.lineageId !== undefined ? { lineageId: itemLabel(s, item.lineageId) } : {}) } as GroundItem<ItemLabel>;
    if (Object.isFrozen(item)) records.set(item, legacy = Object.freeze(legacy));
  }
  return legacy;
}

export function legacyItems(s: Game, items: readonly GroundItem[]): GroundItem<ItemLabel>[] {
  let legacy = lists.get(items);
  if (!legacy) {
    legacy = items.map(item => legacyGround(s, item));
    lists.set(items, legacy); sources.set(legacy, items);
    shareItemPublication(items, legacy);
  }
  return legacy;
}

/** The original frozen frame supplies ownership. A historical frame never reads today's items. */
export function legacyItemsInRange(s: Game, frame: readonly GroundItem<ItemLabel>[], at: Vec2, reach: number,
  keep: (item: Vec2) => boolean): GroundItem<ItemLabel>[] {
  const numeric = sources.get(frame);
  return numeric ? framedItems(s, numeric, at, reach, keep).map(item => legacyGround(s, item)) : frame.filter(keep);
}

function legacyInventory(s: Game, item: InventoryItem): InventoryItem<ItemLabel> {
  return { ...item,
    ...(item.instanceId !== undefined ? { instanceId: itemLabel(s, item.instanceId) } : {}),
    ...(item.lineageId !== undefined ? { lineageId: itemLabel(s, item.lineageId) } : {}) } as InventoryItem<ItemLabel>;
}

/** Mutate only a frame's private clone; source player records and inventories stay numeric. */
export function legacyPlayers(s: Game, players: Player[]): Player<ItemLabel>[] {
  for (const p of players) {
    if (p.inventory) (p as unknown as Player<ItemLabel>).inventory = p.inventory.map(item => item && legacyInventory(s, item));
    if (p.reload) (p.reload as unknown as { instanceId: ItemLabel }).instanceId = itemLabel(s, p.reload.instanceId);
  }
  return players as unknown as Player<ItemLabel>[];
}
