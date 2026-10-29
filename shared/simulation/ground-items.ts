import type { Game, GroundItem } from '../types.ts';

// The ground list follows the shared-frame model (#655, 22.1 "Frames"): a published frame holds `s.map.items`
// and its records by reference, so both are frozen when published. A step that changes the ground replaces
// what it touches instead of editing it, and a tick that changes nothing copies nothing. Map setup, before
// the first frame, may still edit records in place.

/** Positions by item id, per list. Built on demand and carried across a copy that only replaces records. */
const indexes = new WeakMap<readonly GroundItem[], Map<string, number>>();
/** Lists a frame holds. Marked, not frozen: V8 walks a frozen array more slowly in `filter` and `JSON.stringify`. */
const published = new WeakSet<readonly GroundItem[]>();

function writable(s: Game): GroundItem[] {
  const list = s.map.items;
  if (!published.has(list)) return list;
  const copy = list.slice(), index = indexes.get(list);
  if (index) indexes.set(copy, index);
  return s.map.items = copy;
}

/** The ground list to add to or remove from. A published list is copied first, pointers only. */
export function groundList(s: Game): GroundItem[] {
  const list = writable(s);
  indexes.delete(list);
  return list;
}

function positions(list: readonly GroundItem[]): Map<string, number> {
  let index = indexes.get(list);
  if (!index) { index = new Map(list.map((item, i) => [String(item.id), i])); indexes.set(list, index); }
  return index;
}

/** Where the ground record with this id sits in `s.map.items`, without scanning the list on every call. */
export function groundPosition(s: Game, id: string): number | undefined {
  const list = s.map.items;
  let index = positions(list), at = index.get(id);
  // A list edited in place without groundList (a test arranging a scenario) is indexed again.
  if (index.size !== list.length || at !== undefined && String(list[at]?.id) !== id) {
    indexes.delete(list); index = positions(list); at = index.get(id);
  }
  return at;
}

/** The ground record with this id. */
export function groundItem(s: Game, id: string): GroundItem | undefined {
  const at = groundPosition(s, id);
  return at === undefined ? undefined : s.map.items[at];
}

/** Put `next` where `item` is on the ground. The id stays: the position index is carried across. */
export function replaceItem(s: Game, item: GroundItem, next: GroundItem): void {
  if (next.id !== item.id) throw new Error(`replacing ground item ${item.id} with ${next.id}`);
  const list = writable(s), hinted = indexes.get(list)?.get(String(item.id));
  const at = hinted !== undefined && list[hinted] === item ? hinted : list.indexOf(item);
  if (at < 0) throw new Error(`ground item ${item.id} is not on the ground`);
  list[at] = next;
}

/** A record's writable copy, for rules that change a ground item as they inspect it. */
export const draftItem = (item: GroundItem): GroundItem => ({ ...item });

/** `item` when the draft changed nothing, else the draft. Equal values keep the shared record. */
export function settledItem(item: GroundItem, draft: GroundItem): GroundItem {
  const keys = Object.keys(item), changed = Object.keys(draft);
  if (keys.length !== changed.length) return draft;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]! as keyof GroundItem;
    if (key !== changed[i] || !Object.is(item[key], draft[key])) return draft;
  }
  return item;
}

/** Freeze the ground list and its new records for frames to share. Free when nothing changed since the last frame. */
export function publishItems(s: Game): readonly GroundItem[] {
  const list = s.map.items;
  if (!published.has(list)) {
    for (const item of list) if (!Object.isFrozen(item)) Object.freeze(item);
    published.add(list);
  }
  return list;
}
