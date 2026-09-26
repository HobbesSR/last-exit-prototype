/**
 * `loot-scatter` -- the catalogue fallback, and the treatment every area can
 * take.
 *
 * The loot and clutter rule lives in `src/regions.ts` and is already tested
 * there. This builder therefore adapts rather than reimplements: it translates a
 * `RegionContext` into the `RegionInput` that function has always taken, and
 * translates its `RegionOutput` back into the wider `RegionEdit` shape. A second
 * copy of the scatter rule would be two places to change the density of loot in,
 * which is exactly the coupling this project avoids.
 *
 * It declares no cells and no segments, so it can never strand a region; the
 * clearance guard is still applied so every builder ends the same way.
 */
import { generateRegion } from "../../regions.ts";
import { guardRegionEdit } from "../clearance.ts";
// Shared with the builders that place props: a prop reaches into the cell next
// to it, so what an area must leave alone is one rule for the whole catalogue.
import { keepClear } from "../placement.ts";
import type { CellClass, RegionCandidate, RegionInput } from "../../types.ts";
import type { RegionBuilder, RegionContext, RegionEdit } from "../types.ts";

const ID = "loot-scatter";

/**
 * `generateRegion` validates its rule strictly and rejects any property it does
 * not own, so the catalogue keys (`generator`, `generatorParams`) are dropped
 * here rather than leaking into a function that predates them.
 */
function clutterRule(rule: CellClass): CellClass {
  const out: CellClass = {};
  if (typeof rule.clutterChance === "number")
    out.clutterChance = rule.clutterChance;
  if (typeof rule.clutterSize === "number") out.clutterSize = rule.clutterSize;
  return out;
}

/**
 * The `RegionInput` this region presents to the legacy scatter pass. Exported
 * because a caller comparing the two surfaces -- or a tool driving
 * `generateRegion` directly -- should not have to guess how a context maps onto
 * it.
 *
 * The two sets are filtered differently, because they mean different things. A
 * spawn is not geometry and only has to avoid the cells another pass owns. A
 * prop is geometry, and `keepClear` is what keeps it out of the cells beside
 * reserved standing room and off the streets crossing the area.
 */
export function scatterInput(context: RegionContext): RegionInput {
  const open = (candidate: { x: number; y: number }): boolean =>
    !context.isReserved(candidate.x, candidate.y);
  const keep = keepClear(context);
  const area: RegionCandidate[] = context.mask.cells
    .filter((cell) => open(cell) && !keep.has(cell.cellIndex))
    .map(({ cellIndex, x, y }) => ({ cellIndex, x, y }));
  return {
    seed: context.seed,
    cellClass: context.cellClass,
    candidates: context.candidates.filter(open),
    budget: context.budget,
    area,
  };
}

export const scatterBuilder: RegionBuilder = {
  id: ID,
  description:
    "Spaced loot slots and small off-lattice props; the fallback every area can take.",
  minArea: 1,
  build(context: RegionContext): RegionEdit {
    const output = generateRegion(
      scatterInput(context),
      clutterRule(context.rule),
    );
    const edit: RegionEdit = {
      spawns: output.spawns,
      obstacles: output.obstacles,
      cells: [],
      segments: [],
      vertices: [],
      features: [],
      // The counts and `corridorsHonored` come from the pass that did the work.
      manifest: { ...output.manifest, generator: ID },
    };
    return guardRegionEdit(context, edit, context.clearance.hunter);
  },
};

export default scatterBuilder;
