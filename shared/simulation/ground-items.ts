import type { Game, GroundItem, Vec2 } from '../types.ts';

// The ground list follows the shared-frame model (#655, 22.1 "Frames"): a published frame holds `s.map.items`
// and its records by reference, so both are frozen when published. A step that changes the ground replaces
// what it touches instead of editing it, and a tick that changes nothing copies nothing. Map setup, before
// the first frame, may still edit records in place.

/** Positions by item id, per list. Built on demand and carried across a copy that only replaces records. */
const indexes = new WeakMap<readonly GroundItem[], Map<string, number>>();
/** Lists a frame holds. Marked, not frozen: V8 walks a frozen array more slowly in `filter` and `JSON.stringify`. */
const published = new WeakSet<readonly GroundItem[]>();

/**
 * Records by coarse cell, so a rule that reaches a few units looks at a few cells instead of the whole map (#641).
 * `order` restores list order: the list only ever appends, removes and replaces in place, so a sequence number
 * given on entry, and kept by a replacement, sorts exactly as positions do. A grid belongs to one list and moves
 * to the copy when that list is copied, so a list that a frame still holds never sees a later change.
 * Only a frozen record sits in a cell, since nothing can move it there. One not yet published may still be
 * edited in place, so it waits in `loose`, which every query reads, until a frame has frozen it.
 */
interface Entry { order: number; bucket: GroundItem[] }
interface Grid { cells: Map<number, GroundItem[]>; loose: GroundItem[]; entries: Map<GroundItem, Entry>; next: number }
const grids = new WeakMap<readonly GroundItem[], Grid>();
const CELL = 64, SPAN = 1 << 15;

/** A cell's key, or undefined for a position no cell holds (non-finite or far off the map). */
function cellKey(x: number, y: number): number | undefined {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  return Math.abs(cx) < SPAN && Math.abs(cy) < SPAN ? (cx + SPAN) * 2 * SPAN + cy + SPAN : undefined;
}

function enter(grid: Grid, item: GroundItem, order = grid.next++): void {
  const key = Object.isFrozen(item) ? cellKey(item.x, item.y) : undefined;
  let bucket = key === undefined ? grid.loose : grid.cells.get(key);
  if (!bucket) grid.cells.set(key!, bucket = []);
  bucket.push(item); grid.entries.set(item, { order, bucket });
}

function unlink(bucket: GroundItem[], item: GroundItem): void {
  bucket[bucket.indexOf(item)] = bucket[bucket.length - 1]!; bucket.pop();
}

/** Take `item` out of its list's grid; its sequence number, for a replacement to keep. A grid that never held it is dropped. */
function leave(list: readonly GroundItem[], item: GroundItem): number | undefined {
  const grid = grids.get(list), entry = grid?.entries.get(item);
  if (!entry) { grids.delete(list); return undefined; }
  unlink(entry.bucket, item); grid!.entries.delete(item);
  return entry.order;
}

function gridOf(list: readonly GroundItem[]): Grid {
  let grid = grids.get(list);
  // A list edited without these functions (a test arranging a scenario) is gridded again.
  if (!grid || grid.entries.size !== list.length) {
    grid = { cells: new Map(), loose: [], entries: new Map(), next: 0 };
    for (const item of list) enter(grid, item);
    grids.set(list, grid);
  } else if (grid.loose.length) {
    // Records frozen since they entered move to their cells; the rest stay loose.
    for (const item of grid.loose.slice()) if (Object.isFrozen(item) && cellKey(item.x, item.y) !== undefined) {
      const { order } = grid.entries.get(item)!;
      unlink(grid.loose, item); enter(grid, item, order);
    }
  }
  return grid;
}

function writable(s: Game): GroundItem[] {
  const list = s.map.items;
  if (!published.has(list)) return list;
  const copy = list.slice(), index = indexes.get(list), grid = grids.get(list);
  if (index) indexes.set(copy, index);
  if (grid) { grids.delete(list); grids.set(copy, grid); }
  return s.map.items = copy;
}

/** The ground list to edit freely. A published list is copied first, pointers only; the indexes are rebuilt on next use. */
export function groundList(s: Game): GroundItem[] {
  const list = writable(s);
  indexes.delete(list); grids.delete(list);
  return list;
}

/** Put records on the ground, after everything already there. */
export function addItems(s: Game, ...items: GroundItem[]): void {
  const list = writable(s), grid = grids.get(list);
  indexes.delete(list);
  list.push(...items);
  if (grid) for (const item of items) enter(grid, item);
}

/** Take a record off the ground; later records keep their order. Returns where it was, which is now where the next one is. */
export function removeItem(s: Game, item: GroundItem): number {
  const list = writable(s), hinted = indexes.get(list)?.get(String(item.id));
  const at = hinted !== undefined && list[hinted] === item ? hinted : list.indexOf(item);
  if (at < 0) throw new Error(`ground item ${item.id} is not on the ground`);
  indexes.delete(list);
  list.splice(at, 1);
  leave(list, item);
  return at;
}

/**
 * Every ground record that could be within `reach` of `at`, in list order: a superset, never a ruling.
 * The caller's own test decides; a record whose position compares as nothing (NaN) is always offered.
 */
export function itemsNear(s: Game, at: Vec2, reach: number): GroundItem[] {
  const list = s.map.items;
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return list.slice();
  const grid = gridOf(list), found = grid.loose.slice();
  // One unit past the reach, so a rounding difference between this bound and the caller's distance cannot exclude.
  const x0 = Math.floor((at.x - reach - 1) / CELL), x1 = Math.floor((at.x + reach + 1) / CELL);
  const y0 = Math.floor((at.y - reach - 1) / CELL), y1 = Math.floor((at.y + reach + 1) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    const key = cellKey(cx * CELL, cy * CELL), bucket = key === undefined ? undefined : grid.cells.get(key);
    if (bucket) for (const item of bucket) found.push(item);
  }
  if (found.length > 1) found.sort((a, b) => grid.entries.get(a)!.order - grid.entries.get(b)!.order);
  return found;
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
  const order = leave(list, item);
  if (order !== undefined) enter(grids.get(list)!, next, order);
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
