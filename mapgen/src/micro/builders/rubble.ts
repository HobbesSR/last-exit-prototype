/**
 * `rubble` -- broken ground: dense, off-lattice debris a contestant threads and
 * a hunter mostly cannot.
 *
 * How dense debris may be is not a matter of taste; it is arithmetic. Props sit
 * on a lattice of `LATTICE_STEP` cells, so two neighbouring props leave a gap of
 *
 *   LATTICE_STEP - (half of each prop's extent, at most its length)
 *
 * and the gap therefore lands in `[LATTICE_STEP - maxLength, LATTICE_STEP]`.
 * Choosing `maxLength = LATTICE_STEP - PASSAGE.squeeze` puts the whole of that
 * range inside the squeeze band `[PASSAGE.squeeze, PASSAGE.door)`: every gap
 * admits every contestant, and no gap is guaranteed to a hunter. Crossing
 * several sticks inside one cell thickens the debris without touching the
 * arithmetic, because a prop never leaves the cell it belongs to.
 *
 * This is the one builder that may make a region hunter-impassable, and it does
 * so deliberately: it is guarded at the contestant radius rather than the hunter
 * radius, and the manifest records the count under `hunterHostile` so an
 * artifact reader can see which regions took that liberty.
 */
import { PASSAGE } from "../scale.ts";
import { createCanvas } from "../edit.ts";
import { guardRegionEdit } from "../clearance.ts";
// Shared with the other builders that place props rather than copied: what
// makes a cell standing room is one rule, and it is the open-field builder that
// first needed it.
import { keepClear, standableSlot } from "../placement.ts";
import type { RegionBuilder, RegionContext, RegionEdit } from "../types.ts";

const ID = "rubble";

/** Cells between occupied cells, in both axes. The gap arithmetic rests on it. */
const LATTICE_STEP = 2;
/** Longest a prop may be if every surviving gap is to stay contestant-passable. */
const MAX_PROP_LENGTH = LATTICE_STEP - PASSAGE.squeeze;
/** Shortest, so debris still reads as debris rather than as gravel. */
const MIN_PROP_LENGTH = MAX_PROP_LENGTH * 0.6;
/** The lattice phase debris takes: the one the spaced candidate slots do not. */
const DEBRIS_PHASE = 0;
/** Sticks crossed inside one cell. Thickens the mess; changes no gap. */
const PROPS_PER_CELL = 2;
/** Fraction of lattice cells that get debris; the rest are the messiness. */
const DENSITY = 0.85;
/** Broken ground hides things well: a slot among the debris is weighted up. */
const DEBRIS_LOOT_BONUS = 2;

/** Read a numeric tuning value from the class rule, or take the module default. */
function tuned(context: RegionContext, key: string, fallback: number): number {
  const value = context.rule.generatorParams?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const rubbleBuilder: RegionBuilder = {
  id: ID,
  description:
    "Dense off-lattice debris leaving contestant-only gaps; may be hunter-impassable.",
  minArea: 12,
  build(context: RegionContext): RegionEdit {
    const canvas = createCanvas(context);
    const { mask } = context;

    // A configured length is capped rather than obeyed: past this the gaps stop
    // admitting a contestant and the region can seal itself, which no tuning
    // value is allowed to do.
    const maxLength = Math.min(
      tuned(context, "propLength", MAX_PROP_LENGTH),
      MAX_PROP_LENGTH,
    );
    const minLength = Math.min(
      maxLength,
      tuned(context, "propLengthMin", MIN_PROP_LENGTH),
    );
    const density = clamp01(tuned(context, "density", DENSITY));
    const perCell = Math.max(
      1,
      Math.round(tuned(context, "propsPerCell", PROPS_PER_CELL)),
    );

    const debrisRng = context.rng.stream("rubble:debris");
    const lootRng = context.rng.stream("rubble:loot");

    const debris = new Set<number>();
    const keep = keepClear(context);
    let props = 0;
    // The debris lattice is the complement of the candidate lattice, which is
    // `lattice(2, 1, 1)` by the harness convention: debris on the odd cells
    // would bury every slot the region was offered and leave nothing to search.
    for (const cell of mask.lattice(LATTICE_STEP, DEBRIS_PHASE, DEBRIS_PHASE)) {
      if (context.isReserved(cell.x, cell.y)) continue;
      if (keep.has(cell.cellIndex)) continue;
      if (!debrisRng.chance(density)) continue;
      let stated = 0;
      for (let stick = 0; stick < perCell; stick += 1) {
        const length = debrisRng.range(minLength, maxLength);
        const angle = debrisRng.next() * Math.PI * 2;
        if (canvas.propInCell(cell.x, cell.y, length, angle)) stated += 1;
      }
      if (stated === 0) continue;
      canvas.claim(cell.x, cell.y);
      debris.add(cell.cellIndex);
      props += stated;
    }

    // Loot goes in the gaps, not under the debris: a slot inside a cell full of
    // sticks is a slot nothing can stand on.
    const nearDebris = (x: number, y: number): boolean => {
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const index = mask.indexOf(x + dx, y + dy);
          if (index >= 0 && debris.has(index)) return true;
        }
      return false;
    };
    let spawned = 0;
    for (const candidate of context.candidates) {
      if (spawned >= context.budget) break;
      if (context.isReserved(candidate.x, candidate.y)) continue;
      if (!standableSlot(mask, debris, candidate.x, candidate.y)) continue;
      const base =
        candidate.lootChance ??
        context.zoneAt(candidate.x, candidate.y).lootChance;
      const weight = nearDebris(candidate.x, candidate.y)
        ? DEBRIS_LOOT_BONUS
        : 1;
      if (!lootRng.chance(clamp01(base * weight))) continue;
      if (canvas.spawn(candidate.cellIndex, "loot")) spawned += 1;
    }

    canvas.note("debrisCells", debris.size);
    canvas.note("props", props);
    // Recorded because it is the one liberty in the catalogue worth auditing.
    canvas.note("hunterHostile", debris.size > 0 ? 1 : 0);
    // Guarded at the contestant radius on purpose: the whole point of broken
    // ground is that the bodies do not both get through it.
    return guardRegionEdit(
      context,
      canvas.finish(ID),
      context.clearance.contestant,
    );
  },
};

export default rubbleBuilder;
