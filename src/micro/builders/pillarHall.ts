/**
 * `pillar-hall` -- cover without enclosure.
 *
 * A regular lattice of small solid blocks is the cheapest way to break a long
 * sightline while leaving the ground completely walkable: nothing here declares
 * a single segment, so there is no door to find and no wall to follow. Material
 * cells are the whole of the output, and material emits its own walls against
 * every non-material neighbour (docs/VOCABULARY.md), so the blocks are stated
 * once, as cells, rather than as four barriers each.
 *
 * Two numbers carry the design:
 *
 * - `aisle` is the free span between blocks and is never below `PASSAGE.wide`,
 *   so two of the largest body still pass abreast anywhere in the hall;
 * - `stride` offsets each successive row by half a period, so a line of sight
 *   down an aisle meets a block in the next row rather than running out of the
 *   region. A stride that divides the period would repeat after two rows and
 *   leave a lane open the whole way, so an even period takes `period / 2 + 1`
 *   instead -- the point is a stagger that does not close back on itself.
 *
 * Only one axis is staggered: staggering both puts block corners diagonally
 * against each other, which pinches the gap shut for every body. Which axis gets
 * the stagger is drawn from the seed, so a map's halls do not all face one way.
 * The unstaggered axis keeps its clean lanes on purpose -- that is the walk the
 * design asks to stay open.
 */
import { PASSAGE } from "../scale.ts";
import { createCanvas } from "../edit.ts";
import { guardRegionEdit } from "../clearance.ts";
import {} from "../../primitives.ts";
// Shared with the builders that place props: what an area must leave alone is
// one rule, and material has to obey it more carefully than a wall does.
import { approachCells, buildableCells } from "../placement.ts";
import type { Box } from "../../types.ts";
import type { RegionBuilder, RegionContext, RegionEdit } from "../types.ts";

const ID = "pillar-hall";

/** Block side in cells. Small: a pillar breaks a shot, it does not stop a walk. */
const BLOCK_SIZE = 2;
/** Free cells between blocks. Never below `PASSAGE.wide`. */
const AISLE = PASSAGE.wide;

/** Read a numeric tuning value from the class rule, or take the module default. */
function tuned(context: RegionContext, key: string, fallback: number): number {
  const value = context.rule.generatorParams?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The lattice a pillar hall is made of, before anything has been declared. */
export interface PillarPlan {
  blockSize: number;
  aisle: number;
  /** `blockSize + aisle`: the distance between one block origin and the next. */
  period: number;
  /** Half a period, adjusted so the stagger never repeats after two rows. */
  stride: number;
  /** True when rows are offset in x; false when columns are offset in y. */
  staggerRows: boolean;
  /** Inclusive cell boxes, ascending by row then column. */
  blocks: Box[];
}

/**
 * Plan the lattice. Pure and deterministic in the context seed, and separate
 * from declaring it so the spacing can be measured without an edit in hand.
 *
 * A block is dropped whole rather than clipped: a half block against the region
 * border reads as rubble, and a block beside an opening narrows the one thing
 * the region cannot afford to lose.
 */
export function planPillars(context: RegionContext): PillarPlan {
  const { mask, grid } = context;
  const blockSize = Math.max(
    1,
    Math.round(tuned(context, "blockSize", BLOCK_SIZE)),
  );
  const aisle = Math.max(PASSAGE.wide, tuned(context, "aisle", AISLE));
  const period = blockSize + Math.ceil(aisle);
  const stride = period % 2 === 0 ? period / 2 + 1 : (period - 1) / 2;
  const staggerRows = context.rng.stream("pillar-hall:axis").chance(0.5);

  // The openings and their standing room. A pillar beside a street is wanted --
  // that is what stops the street being a clear shot -- so the street itself is
  // the only reserved ground a block must stay off, and `keepClear`, which also
  // excludes every cell *beside* reserved ground, is the wrong rule here: with
  // a tile anchor in every tile it left no legal block anywhere on a 936-tile
  // map, and reported no refusals, because a block that is never proposed is
  // never refused.
  //
  // Material now states its own boundary walls in `canvas.finish`, so a block
  // is a barrier the clearance guard can see and take back if it severs the
  // route; before that it was a label on a cell and nothing else.
  const approaches = approachCells(context);
  const buildable = buildableCells(context);

  const [minX, minY, maxX, maxY] = mask.bounds;
  const alignedOrigin = (value: number): number => {
    const snapped = grid.snap(value);
    return snapped <= value ? snapped : snapped - grid.tileSize;
  };
  const originX = alignedOrigin(minX);
  const originY = alignedOrigin(minY);
  const columns = Math.ceil((maxX - originX + 1) / period) + 1;
  const rows = Math.ceil((maxY - originY + 1) / period) + 1;

  const blocks: Box[] = [];
  for (let j = 0; j <= rows; j += 1)
    for (let i = 0; i <= columns; i += 1) {
      const x0 =
        originX + i * period + (staggerRows ? (j * stride) % period : 0);
      const y0 =
        originY + j * period + (staggerRows ? 0 : (i * stride) % period);
      const box: Box = [x0, y0, x0 + blockSize - 1, y0 + blockSize - 1];
      if (box[0] > maxX || box[1] > maxY || box[2] < minX || box[3] < minY)
        continue;
      let usable = true;
      for (let y = box[1]; y <= box[3] && usable; y += 1)
        for (let x = box[0]; x <= box[2] && usable; x += 1) {
          const index = mask.indexOf(x, y);
          usable = index >= 0 && buildable.has(index) && !approaches.has(index);
        }
      if (usable) blocks.push(box);
    }
  return { blockSize, aisle, period, stride, staggerRows, blocks };
}

export const pillarHallBuilder: RegionBuilder = {
  id: ID,
  description:
    "A staggered lattice of small solid blocks: broken sightlines, fully open ground.",
  minArea: 36,
  build(context: RegionContext): RegionEdit {
    const canvas = createCanvas(context);
    const plan = planPillars(context);
    const lootRng = context.rng.stream("pillar-hall:loot");

    let cells = 0;
    let blocks = 0;
    for (const box of plan.blocks) {
      let stated = 0;
      for (let y = box[1]; y <= box[3]; y += 1)
        for (let x = box[0]; x <= box[2]; x += 1) {
          if (canvas.isClaimed(x, y)) continue;
          if (!canvas.cell(x, y, { class: "solid" })) continue;
          canvas.claim(x, y);
          stated += 1;
        }
      if (stated > 0) blocks += 1;
      cells += stated;
    }

    // Loot sits where it always did. A hall hides nothing by itself; what it
    // gives is the approach, and an approach is only worth the walk if the
    // slot at the end of it is the ordinary one.
    const solid = new Set<number>();
    for (const box of plan.blocks)
      for (let y = box[1]; y <= box[3]; y += 1)
        for (let x = box[0]; x <= box[2]; x += 1) {
          const index = context.mask.indexOf(x, y);
          if (index >= 0) solid.add(index);
        }
    let spawned = 0;
    for (const candidate of context.candidates) {
      if (spawned >= context.budget) break;
      if (context.isReserved(candidate.x, candidate.y)) continue;
      if (solid.has(candidate.cellIndex)) continue;
      const base =
        candidate.lootChance ??
        context.zoneAt(candidate.x, candidate.y).lootChance;
      if (!lootRng.chance(base)) continue;
      if (canvas.spawn(candidate.cellIndex, "loot")) spawned += 1;
    }

    canvas.note("blocks", blocks);
    canvas.note("blockCells", cells);
    canvas.note("period", plan.period);
    canvas.note("stride", plan.stride);
    canvas.note("staggerRows", plan.staggerRows ? 1 : 0);
    return guardRegionEdit(
      context,
      canvas.finish(ID),
      context.clearance.hunter,
    );
  },
};

export default pillarHallBuilder;
