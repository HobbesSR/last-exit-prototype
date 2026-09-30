/**
 * Where loot goes, decided by the region that is about to hold it.
 *
 * Macro says how much and of what tier (`src/plan/loot.ts`); this is the other
 * half of the same sentence. The region is the only thing that knows what it
 * just built, so it is the only thing that can say which cells are still worth
 * standing in, and the placement rule is deliberately the simplest one that
 * can be checked: choose cells inside the region, at most one spawn per cell.
 *
 * Every builder calls this in one line rather than writing its own scatter --
 * five of them had one, they disagreed about reserved ground, and each was a
 * separate place for the standing-room rule to be forgotten:
 *
 * ```ts
 * for (const spawn of placeLoot(context, criteria, blocked).spawns)
 *   canvas.spawn(spawn.cellIndex, spawn.kind);
 * ```
 *
 * `criteria` is a parameter rather than a field read off the context because
 * the legacy path has no macro plan: regions there are discovered from cell
 * classes after the fact, `context.loot` is absent, and the caller derives the
 * criteria itself. The rule for where a spawn may sit is the same either way,
 * which is the whole reason it is one function.
 */
import type { RegionSpawn } from "../types.ts";
import { standableSlot } from "./placement.ts";
import type { CellRef, LootCriteria, RegionContext } from "./types.ts";

/**
 * What the region managed. `placed < wanted` is a report, not an error: this
 * project counts manifests against what actually landed, so a shortfall has to
 * be visible rather than rounded away into a budget nobody checks.
 */
export interface LootPlacement {
  spawns: RegionSpawn[];
  placed: number;
  /** The target after both caps, so a shortfall means the region had no room. */
  wanted: number;
}

/** Every spawn this pass claims is loot; the tier is carried by the criteria. */
const SPAWN_KIND = "loot";
/**
 * The spacing convention already in force: `core.generateMicro` offers spawn
 * candidates on exactly this lattice, and `mask.lattice` documents it as the
 * default candidate set. Both coordinates are odd on it, so no two cells of the
 * lattice are orthogonally adjacent -- which is what actually buys the spread.
 */
const LATTICE_STEP = 2;
const LATTICE_PHASE = 1;

const NO_CELLS: ReadonlySet<number> = Object.freeze(new Set<number>());

/**
 * A cap as a whole number. A non-finite cap is treated as unbounded when it is
 * positive and as zero otherwise, because `Infinity` is a legitimate way for a
 * caller to say "no ceiling of my own" and `NaN` never means "as much as you
 * like".
 */
function asCap(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Choose cells in the region for loot. At most one spawn per cell, never on a
 * cell another pass owns or the builder has already taken.
 *
 * Three passes, and the order is the design:
 *
 * 1. the spaced lattice, which cannot produce two adjacent spawns at all;
 * 2. the remaining cells, skipping anything beside a spawn already placed;
 * 3. the remaining cells, unconditionally.
 *
 * A budget that fits on the lattice never reaches pass 2, so the ordinary case
 * is spread by construction and only a region asked for more than its spacing
 * can hold starts to fill in. Loot in a heap is not a search, and a region that
 * quietly clumped would still pass every count-based check.
 *
 * `taken` is the builder's own claim -- walls, props, the footprint of whatever
 * it built -- and is read twice: those cells are never offered, and they are
 * what `standableSlot` treats as blocked when it asks whether a body could
 * reach the slot at all. Reserved ground is different and is only a candidacy
 * filter: a street or a tile anchor is somewhere a body walks, so loot beside
 * one is fine, and excluding the ring around reserved cells is exactly the
 * mistake `placement.ts` records as having left nowhere to build.
 */
export function placeLoot(
  context: RegionContext,
  criteria: LootCriteria,
  /** Cells the builder has already claimed; these are never offered. */
  taken: ReadonlySet<number> = NO_CELLS,
): LootPlacement {
  const mask = context.mask;
  const blocked = taken ?? NO_CELLS;
  // Two ceilings, both hard. The context's is the harness's word on what this
  // region may claim in total and it may be tighter than what macro asked for;
  // neither may be exceeded, so `wanted` is the smaller.
  const wanted = Math.min(asCap(criteria?.budget ?? 0), asCap(context.budget));
  if (wanted <= 0 || mask.area === 0)
    return { spawns: [], placed: 0, wanted: Math.max(0, wanted) };

  const rng = context.rng.stream("loot");
  const spaced = mask.lattice(LATTICE_STEP, LATTICE_PHASE, LATTICE_PHASE);
  const onLattice = new Set(spaced.map((cell) => cell.cellIndex));
  const rest = mask.cells.filter((cell) => !onLattice.has(cell.cellIndex));
  // One shuffled order for the dense cells, walked twice under different rules,
  // so the fill-in pass does not reorder what the spread-out pass rejected.
  // Named streams rather than draws off one sequence: adding a pass here must
  // not move the cells an unrelated pass chose.
  const denseOrder = rng.stream("dense").shuffle(rest);
  const passes: Array<{ cells: readonly CellRef[]; apart: boolean }> = [
    { cells: rng.stream("spaced").shuffle(spaced), apart: true },
    { cells: denseOrder, apart: true },
    { cells: denseOrder, apart: false },
  ];

  const chosen = new Set<number>();
  const beside = (x: number, y: number): boolean =>
    chosen.has(mask.indexOf(x - 1, y)) ||
    chosen.has(mask.indexOf(x + 1, y)) ||
    chosen.has(mask.indexOf(x, y - 1)) ||
    chosen.has(mask.indexOf(x, y + 1));

  for (const pass of passes) {
    if (chosen.size >= wanted) break;
    for (const cell of pass.cells) {
      if (chosen.size >= wanted) break;
      // The stated rule, enforced rather than assumed: the candidate lists are
      // disjoint by construction, but "at most one spawn per cell" is what the
      // whole contract rests on and it costs one lookup to mean it.
      if (chosen.has(cell.cellIndex)) continue;
      if (blocked.has(cell.cellIndex)) continue;
      if (context.isReserved(cell.x, cell.y)) continue;
      // A spawn nobody can reach is worse than no spawn, and this project has
      // already paid a region's walls for one stranded slot. The judgement is
      // `placement.ts`'s and stays there.
      if (!standableSlot(mask, blocked, cell.x, cell.y)) continue;
      if (pass.apart && beside(cell.x, cell.y)) continue;
      chosen.add(cell.cellIndex);
    }
  }

  // Ascending by cell index, as every other ordered output in the project is:
  // the draw order is an implementation detail and a manifest that reordered
  // itself when a pass changed would fail a seed sweep for no reason.
  const spawns = [...chosen]
    .sort((left, right) => left - right)
    .map((cellIndex) => ({ cellIndex, kind: SPAWN_KIND }));
  return { spawns, placed: spawns.length, wanted };
}
