/**
 * Macro loot allocation: how much, and of what tier.
 *
 * The split this module exists to keep is the one in docs/VOCABULARY.md under
 * "Builders": macro decides how much loot a region owes and what tier it is,
 * because that is progression and progression is a property of *where* the
 * region sits. Where the spawns actually land is the region's own business --
 * it is the only thing that knows what it just built -- and that half lives in
 * `src/micro/loot.ts`. Nothing here may name a cell.
 *
 * So the output is a `LootCriteria`: a count, a tier, and a per-cell chance for
 * a builder that would rather scatter than count. It is arithmetic over the
 * region's area and tier, with no rng at all -- a budget that varied run to run
 * would make the manifest counts unreadable, and there is nothing here a random
 * draw would improve.
 *
 * ## How this relates to `params.lootChance` / `params.lootTierStep`
 *
 * Those are the legacy expression of the same idea and they are a different
 * *kind* of number: a per-cell chance, rolled by `regions.ts` over the spaced
 * candidate set `lattice(2, 1, 1)` -- a quarter of a region's cells. So the
 * legacy expected yield per 100 region cells is `25 * (lootChance + (tier - 1)
 * * lootTierStep)`, which under `DEFAULT_PARAMS` (0.04 / 0.09) runs 1.0 at
 * tier 1 to 10.0 at tier 5.
 *
 * The policy default here is 6.0 at tier 1 rising to 14.4 at tier 5 (`6 * (1 +
 * 0.35 * 4)`). Deliberately more at the low end and a far flatter ramp: one
 * slot per hundred cells is a tier-1 region with effectively nothing in it, and
 * a run that begins with nothing to find is not a search. The ramp stays a ramp
 * -- 2.4x across the map is still "loot tiers increase from left to right in
 * five levels" -- but the *tier* on the criteria is what carries progression
 * now, and quality was always the point of a tier; the count is only how much
 * of it there is. Both numbers are policy and both are reversible.
 *
 * `params` still has the last word on one thing: `lootChance` of 0 turns loot
 * off map-wide on the legacy path, and it has to mean the same here, or a
 * caller that switched generation paths silently gets its loot back.
 */
export type { PartitionedRegion } from "./types.ts";
import type { PartitionedRegion } from "./types.ts";
import type { LootCriteria } from "../micro/types.ts";
import type { MapParams } from "../types.ts";

/** Knobs on the allocation. All optional; the defaults are the shipped policy. */
export interface LootPolicy {
  /** Expected spawns per 100 cells at tier 1. Default 6. */
  perHundredCells?: number;
  /** Multiplier added per tier above 1, as a fraction. Default 0.35. */
  tierStep?: number;
  /** Hard cap on one region's budget, so one huge region cannot eat the map. */
  maxPerRegion?: number;
}

const DEFAULT_PER_HUNDRED = 6;
const DEFAULT_TIER_STEP = 0.35;
/**
 * The default ceiling. A partition can hand back a region of a thousand cells,
 * and at 6 per hundred that is sixty slots in one place -- more than the rest
 * of a tier put together, and a hoard rather than a find. Twenty is roughly
 * what a 330-cell region earns, which is a large region by the shipped
 * partition, so the cap binds only on the outliers it is there for.
 */
const DEFAULT_MAX_PER_REGION = 20;

/** Horizontal progression runs 1..5 (docs/VOCABULARY.md, "Tier zone"). */
const TIER_MIN = 1;
const TIER_COUNT = 5;

/** A finite non-negative number, or the fallback. Policy fields are caller data. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * What one region owes.
 *
 * `budget` is a count and a hard cap both, so it is clamped to the region's own
 * area before anything else: one spawn per cell is the placement rule, so a
 * budget above the cell count is unsatisfiable by construction and asking for
 * it would only teach the micro side to report a shortfall that macro invented.
 */
export function deriveLoot(
  region: PartitionedRegion,
  params: MapParams,
  policy?: LootPolicy,
): LootCriteria {
  const tier = region.tier;
  const area = region.cells.length;
  // The legacy master switch, honoured across both paths. `> 0` rather than
  // `!== 0` so a NaN out of a hand-built params means "off" and not "all".
  if (!(params.lootChance > 0) || area <= 0) {
    return { budget: 0, tier, density: 0 };
  }

  const perHundred = positive(policy?.perHundredCells, DEFAULT_PER_HUNDRED);
  const step = positive(policy?.tierStep, DEFAULT_TIER_STEP);
  const ceiling = positive(policy?.maxPerRegion, DEFAULT_MAX_PER_REGION);

  // Tier is clamped for the multiplier only: `criteria.tier` stays the region's
  // own tier, because a builder varying its form with progression must see what
  // the zone actually said, not what the budget formula could make use of.
  const steps = Math.min(TIER_COUNT, Math.max(TIER_MIN, tier)) - TIER_MIN;
  const rate = (perHundred / 100) * (1 + step * steps);
  const budget = Math.min(
    Math.max(0, Math.round(area * rate)),
    area,
    Math.floor(ceiling),
  );

  // The per-cell chance that yields this budget in expectation over the whole
  // region -- every cell, not the spaced lattice the legacy path rolls on. A
  // builder scattering over a subset has to scale it itself.
  return { budget, tier, density: Math.min(1, Math.max(0, budget / area)) };
}

/**
 * The same for a whole partition, plus the totals a caller wants to see.
 *
 * The totals are returned rather than recomputed by every caller because they
 * are what a plan is checked against: a manifest counts what actually landed,
 * and the only way to say whether the map is short is to have said first what
 * it was owed.
 */
export function allocateLoot(
  regions: readonly PartitionedRegion[],
  params: MapParams,
  policy?: LootPolicy,
): { loot: Map<string, LootCriteria>; total: number; byTier: number[] } {
  const loot = new Map<string, LootCriteria>();
  let total = 0;
  let highest = TIER_COUNT;
  for (const region of regions)
    if (Number.isFinite(region.tier) && region.tier > highest)
      highest = Math.floor(region.tier);
  // Indexed BY TIER, not by position: `byTier[3]` is tier 3. Real tiers run
  // 1..5, so slot 0 is empty unless a caller invented a region with no tier, in
  // which case its budget lands there rather than being quietly folded into
  // tier 1. Off-by-one in a progression report is not a bug anyone spots.
  const byTier = new Array<number>(highest + 1).fill(0);

  for (const region of regions) {
    const criteria = deriveLoot(region, params, policy);
    loot.set(region.id, criteria);
    total += criteria.budget;
    const at = Number.isFinite(criteria.tier)
      ? Math.min(highest, Math.max(0, Math.floor(criteria.tier)))
      : 0;
    byTier[at] = byTier[at]! + criteria.budget;
  }
  return { loot, total, byTier };
}
