import type { DiscoveryMemory, GroundItem, ItemId, Vec2 } from '../types.ts';

// What a contestant bot has discovered, kept so that a decision reads what is near it and what is new, not everything
// it has ever learned (#864, #635). Both structures are ordinary `Map` and `Set` to every other reader; each keeps an index
// in step with its own mutations, so an edit made from anywhere (discovery, a test arranging a scenario) is seen. The
// indexes keep the order a scan of the whole collection would meet records in, because a tie in a bot's choice
// goes to the first it meets, and a different winner would be a different match.

/** The order a bot looks from a cell to the cells beside it. A tie in the exploration choice goes to the first met. */
export const NEIGHBOURS = [[1, 0], [0, 1], [0, -1], [-1, 0]] as const;

/**
 * Cells a bot has had in line of sight, with the exploration frontier kept beside them: the cells not yet seen that
 * touch one that is, in the order a scan of this set (insertion order, then `NEIGHBOURS`) first meets them. Seeing a
 * cell takes it off the frontier and puts its unseen neighbours on, so a choice reads the frontier and not every seen
 * cell. A cell that gains a second seen neighbour keeps its place: the first seen neighbour is always the earliest.
 */
export class SeenCells extends Set<number> {
  readonly cols: number;
  readonly rows: number;
  #frontier = new Set<number>();
  #stale = false;

  constructor(cols: number, rows: number) {
    super();
    this.cols = cols; this.rows = rows;
  }

  /** A copy of `cells`, in its order, for a grid of `cols` by `rows`. */
  static from(cells: Iterable<number>, cols: number, rows: number): SeenCells {
    const seen = new SeenCells(cols, rows);
    for (const index of cells) seen.add(index);
    return seen;
  }

  override add(index: number): this {
    if (super.has(index)) return this;
    super.add(index);
    if (this.#stale) return this;
    this.#frontier.delete(index);
    const { cols, rows } = this, col = index % cols, row = (index - col) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc, r = row + dr, next = r * cols + c;
      if (c < 0 || r < 0 || c >= cols || r >= rows || super.has(next)) continue;
      this.#frontier.add(next);
    }
    return this;
  }

  /** Cells are only ever added; a removal is for a test arranging a scenario, and the frontier is derived again on next use. */
  override delete(index: number): boolean {
    const removed = super.delete(index);
    if (removed) this.#stale = true;
    return removed;
  }

  override clear(): void {
    super.clear();
    this.#stale = true;
  }

  /** The cells to look at: unseen and beside a seen one, in scan order. */
  get frontier(): ReadonlySet<number> {
    if (this.#stale) {
      const cells = [...this];
      this.#frontier = new Set(); this.#stale = false;
      super.clear();
      for (const index of cells) this.add(index);
    }
    return this.#frontier;
  }
}

/** A remembered item with the order it was first remembered in, which a scan of the memory would meet it in. */
interface Held { seq: number; item: GroundItem; bucket: Held[] | null }
/** Loot is found by coarse cell. A bot reaches about 210 units, so a few cells answer a query. */
const BUCKET = 256, SPAN = 1 << 15;

function bucketKey(x: number, y: number): number | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const cx = Math.floor(x / BUCKET), cy = Math.floor(y / BUCKET);
  return Math.abs(cx) < SPAN && Math.abs(cy) < SPAN ? (cx + SPAN) * 2 * SPAN + cy + SPAN : undefined;
}

/**
 * Items as a bot last saw them (`DiscoveryMemory.items`), in insertion order, with the two questions a bot asks of
 * them answered without a scan: the power cells (a few, kept apart) and the other items near a point (kept in a grid).
 * A record is never edited in place once remembered; replacing it under its id keeps its place, as a `Map` does.
 */
export class ItemMemory extends Map<ItemId, GroundItem> {
  #held = new Map<ItemId, Held>();
  #cells = new Map<ItemId, Held>();
  #grid = new Map<number, Held[]>();
  /** Items with no usable position are offered to every query, as a position that compares as nothing is by `itemsNear`. */
  #loose: Held[] = [];
  #next = 0;

  static from(items: Iterable<readonly [ItemId, GroundItem]>): ItemMemory {
    const memory = new ItemMemory();
    for (const [id, item] of items) memory.set(id, item);
    return memory;
  }

  override set(id: ItemId, item: GroundItem): this {
    const held = this.#held.get(id);
    super.set(id, item);
    if (held) this.#unlink(id, held);
    const entry: Held = { seq: held ? held.seq : this.#next++, item, bucket: null };
    this.#held.set(id, entry);
    if (item.kind === 'cell') this.#cells.set(id, entry);
    else {
      const key = bucketKey(item.x, item.y);
      let bucket = key === undefined ? this.#loose : this.#grid.get(key);
      if (!bucket) this.#grid.set(key!, bucket = []);
      bucket.push(entry); entry.bucket = bucket;
    }
    return this;
  }

  override delete(id: ItemId): boolean {
    const held = this.#held.get(id);
    if (held) { this.#unlink(id, held); this.#held.delete(id); }
    return super.delete(id);
  }

  override clear(): void {
    super.clear();
    this.#held.clear(); this.#cells.clear(); this.#grid.clear(); this.#loose = [];
  }

  #unlink(id: ItemId, held: Held): void {
    if (held.item.kind === 'cell') { this.#cells.delete(id); return; }
    const bucket = held.bucket!, at = bucket.indexOf(held);
    bucket[at] = bucket[bucket.length - 1]!; bucket.pop();
    if (!bucket.length && bucket !== this.#loose) this.#grid.delete(bucketKey(held.item.x, held.item.y)!);
  }

  /** The power cells, in the order they were remembered, which an id that changes kind keeps. */
  cellItems(): GroundItem[] { return [...this.#cells.values()].sort((a, b) => a.seq - b.seq).map(held => held.item); }

  /**
   * The items that are not power cells and could be within `reach` of `at`, in the order they were remembered: a
   * superset, never a ruling, so the caller's own distance test decides.
   */
  near(at: Vec2, reach: number): GroundItem[] {
    const found: Held[] = this.#loose.slice();
    // One unit past the reach, so a rounding difference between this bound and the caller's distance cannot exclude.
    const x0 = Math.floor((at.x - reach - 1) / BUCKET), x1 = Math.floor((at.x + reach + 1) / BUCKET);
    const y0 = Math.floor((at.y - reach - 1) / BUCKET), y1 = Math.floor((at.y + reach + 1) / BUCKET);
    if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1))) {
      for (const held of this.#held.values()) if (held.item.kind !== 'cell') found.push(held);
    } else for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const bucket = Math.abs(cx) < SPAN && Math.abs(cy) < SPAN ? this.#grid.get((cx + SPAN) * 2 * SPAN + cy + SPAN) : undefined;
      if (bucket) for (const held of bucket) found.push(held);
    }
    return found.sort((a, b) => a.seq - b.seq).map(held => held.item);
  }
}

/**
 * The indexed form of a bot's remembered items, or undefined when it has none. Memory made by `discover` is indexed
 * already; a plain `Map` put there by a scenario is replaced by an indexed copy, once.
 */
export function rememberedItems(memory: DiscoveryMemory): ItemMemory | undefined {
  const items = memory.items;
  if (!items || items instanceof ItemMemory) return items;
  return memory.items = ItemMemory.from(items);
}

/**
 * The seen cells a bot explores from, indexed. `discovered` stands in until a bot has seen anything (a person's
 * contestant handed to a bot before its first sample); it is derived on each use, since it is the view window's cells
 * and not the bot's to keep.
 */
export function seenCells(memory: DiscoveryMemory, cols: number, rows: number): SeenCells {
  const seen = memory.seen;
  if (seen instanceof SeenCells && seen.cols === cols && seen.rows === rows) return seen;
  const indexed = SeenCells.from(seen ?? memory.discovered, cols, rows);
  if (seen) memory.seen = indexed;
  return indexed;
}
