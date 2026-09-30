/**
 * `open-field` -- the default treatment for large open ground, and the main
 * answer to "not a clear shot".
 *
 * The map this feeds must be open, so this builder does not subdivide its area:
 * it obstructs it. Cover arrives as loose clusters -- a handful of off-lattice
 * props and the occasional short wall stub -- sited on a coarse lattice whose
 * period is one tile. Between clusters the ground is untouched, which is what
 * keeps the aisles roads rather than corridors:
 *
 *   centres `clusterSpacing` apart, geometry within `CLUSTER_EXTENT` cells of a
 *   centre => at least `clusterSpacing - 2 * CLUSTER_EXTENT - 1` free cells
 *   between two clusters, which at the default of 6 is exactly `PASSAGE.wide`.
 *
 * A stub is two or three segments of wall, never the fourth wall of anything: a
 * stub whose two ends both touch geometry already declared would close a loop,
 * and a loop is an enclosure, which this builder is not in the business of.
 * Loot goes behind cover in preference to the open, because a slot visible from
 * across the field is not a search.
 */
import { PASSAGE } from "../scale.ts";
import { createCanvas } from "../edit.ts";
import { guardRegionEdit } from "../clearance.ts";
import { PROP_MARGIN, keepClear, standableSlot } from "../placement.ts";
import type {
  CellRef,
  RegionBuilder,
  RegionContext,
  RegionEdit,
} from "../types.ts";
import type { RegionCandidate } from "../../types.ts";

const ID = "open-field";

/** Cells between cluster centres. One tile, so clusters read as sited, not strewn. */
const CLUSTER_SPACING = 6;
/** Chebyshev cells a cluster's geometry may reach from its centre. */
const CLUSTER_EXTENT = 1;
/** Chance a lattice point becomes a cluster at tier 1, and the step per tier. */
const CLUSTER_CHANCE = 0.55;
const TIER_DENSITY_STEP = 0.08;
const CLUSTER_CHANCE_CAP = 0.95;
/** Props per cluster, before the tier bonus. */
const PROPS_MIN = 2;
const PROPS_MAX = 4;
/** Prop length in cells. Under 1 so a prop lives in the cell it belongs to. */
const PROP_LENGTH = 0.6;
/** Chance a cluster also gets wall stubs, and how many it may then get. */
const STUB_CHANCE = 0.35;
const STUBS_MAX = 2;
const STUB_MIN_SEGMENTS = 2;
const STUB_MAX_SEGMENTS = 3;
/**
 * How far from cover a slot still counts as behind it. Two cells, because the
 * cell pressed against a prop is usually not standing room: see `standableSlot`.
 */
const COVER_REACH = 2;
/** Loot weighting: a covered slot is worth this much more than an exposed one. */
const COVER_BONUS = 2.5;
const EXPOSED_PENALTY = 0.4;

/** Read a numeric tuning value from the class rule, or take the module default. */
function tuned(context: RegionContext, key: string, fallback: number): number {
  const value = context.rule.generatorParams?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The cluster lattice, before anything has been declared over it. */
export interface ClusterPlan {
  /** Cells between centres; never small enough to close the aisle between two. */
  spacing: number;
  /** Chebyshev cells a cluster's geometry may reach from its centre. */
  extent: number;
  /** The centres this region actually got, ascending by cell index. */
  centres: CellRef[];
}

/**
 * Where the clusters go. Pure and deterministic in the context seed and free of
 * the canvas, so the aisle between two clusters can be measured without an edit
 * in hand -- which is the one invariant this builder exists to keep.
 *
 * Density rises with the tier, so the far end of the map is the busier end.
 */
export function planClusters(context: RegionContext): ClusterPlan {
  const spacing = Math.max(
    tuned(context, "clusterSpacing", CLUSTER_SPACING),
    2 * CLUSTER_EXTENT + PASSAGE.wide + 1,
  );
  const baseChance = tuned(context, "clusterChance", CLUSTER_CHANCE);
  const tierStep = tuned(context, "tierDensityStep", TIER_DENSITY_STEP);
  const placeRng = context.rng.stream("open-field:clusters");
  // A phase of half the period puts a centre in the middle of each tile when
  // the period is the tile itself, which is the aligned case worth having.
  const phase = Math.floor(spacing / 2) % spacing;
  const centres = context.mask
    .lattice(spacing, phase, phase)
    .filter((centre) => {
      if (context.isReserved(centre.x, centre.y)) return false;
      const tier = context.zoneAt(centre.x, centre.y).tier;
      return placeRng.chance(
        Math.min(CLUSTER_CHANCE_CAP, baseChance + tierStep * (tier - 1)),
      );
    });
  return { spacing, extent: CLUSTER_EXTENT, centres };
}

export const openFieldBuilder: RegionBuilder = {
  id: ID,
  description:
    "Loose clusters of cover on wide open ground, with loot hidden behind them.",
  minArea: 24,
  build(context: RegionContext): RegionEdit {
    const canvas = createCanvas(context);
    const { mask } = context;
    const plan = planClusters(context);
    const propLength = tuned(context, "propLength", PROP_LENGTH);
    const stubChance = tuned(context, "stubChance", STUB_CHANCE);

    const propRng = context.rng.stream("open-field:props");
    const stubRng = context.rng.stream("open-field:stubs");
    const lootRng = context.rng.stream("open-field:loot");

    /** Cells carrying declared cover, for the loot pass to search around. */
    const cover = new Set<number>();
    /** Cells a prop sits in: cover to hide behind, and nowhere to stand. */
    const blocked = new Set<number>();
    const keep = keepClear(context);
    /** Vertices a declared stub passes through; the loop test reads this. */
    const touched = new Set<string>();
    let clusters = 0;
    let props = 0;
    let stubs = 0;
    let loopsRefused = 0;

    const markCover = (x: number, y: number): void => {
      const index = mask.indexOf(x, y);
      if (index >= 0) cover.add(index);
    };

    for (const centre of plan.centres) {
      const tier = context.zoneAt(centre.x, centre.y).tier;
      clusters += 1;

      // Props are what a cluster is mostly made of; the stub is the exception
      // that makes one of them read as a ruin rather than as a bush.
      const wanted = propRng.int(PROPS_MIN, PROPS_MAX) + (tier >= 4 ? 1 : 0);
      const around: CellRef[] = [];
      for (let dy = -CLUSTER_EXTENT; dy <= CLUSTER_EXTENT; dy += 1)
        for (let dx = -CLUSTER_EXTENT; dx <= CLUSTER_EXTENT; dx += 1) {
          const x = centre.x + dx;
          const y = centre.y + dy;
          const index = mask.indexOf(x, y);
          if (
            index >= 0 &&
            !context.isReserved(x, y) &&
            !keep.has(index) &&
            mask.depthAt(x, y) >= PROP_MARGIN
          )
            around.push({ cellIndex: index, x, y });
        }
      for (const cell of propRng.shuffle(around).slice(0, wanted)) {
        if (canvas.isClaimed(cell.x, cell.y)) continue;
        const angle = propRng.next() * Math.PI * 2;
        if (!canvas.propInCell(cell.x, cell.y, propLength, angle)) continue;
        canvas.claim(cell.x, cell.y);
        markCover(cell.x, cell.y);
        blocked.add(cell.cellIndex);
        props += 1;
      }

      if (!stubRng.chance(stubChance)) continue;
      for (
        let remaining = stubRng.int(1, STUBS_MAX);
        remaining > 0;
        remaining -= 1
      ) {
        const vertical = stubRng.chance(0.5);
        const length = stubRng.int(STUB_MIN_SEGMENTS, STUB_MAX_SEGMENTS);
        // The stub runs along one lattice line through the cluster, so both the
        // wall and the cells it divides stay inside CLUSTER_EXTENT.
        const line = (vertical ? centre.x : centre.y) + stubRng.int(0, 1);
        const start = (vertical ? centre.y : centre.x) - 1;
        const vertexKey = (offset: number): string =>
          vertical ? `${line},${offset}` : `${offset},${line}`;
        const ends = [vertexKey(start), vertexKey(start + length)];
        // Both ends already on declared geometry closes a loop: an enclosure by
        // accident is the one thing a cover cluster must never become.
        if (ends.every((end) => touched.has(end))) {
          loopsRefused += 1;
          continue;
        }
        const run: Array<{ offset: number }> = [];
        for (let step = 0; step < length; step += 1) {
          const offset = start + step;
          const ref = vertical
            ? canvas.between(line - 1, offset, line, offset)
            : canvas.between(offset, line - 1, offset, line);
          if (!ref) break;
          run.push({ offset });
        }
        if (run.length < STUB_MIN_SEGMENTS) continue;
        let placed = 0;
        for (const { offset } of run) {
          continue;
          placed += 1;
          touched.add(vertexKey(offset));
          touched.add(vertexKey(offset + 1));
          if (vertical) {
            markCover(line - 1, offset);
            markCover(line, offset);
          } else {
            markCover(offset, line - 1);
            markCover(offset, line);
          }
        }
        if (placed > 0) stubs += 1;
      }
    }

    // Loot: covered slots are offered first and weighted up, so the budget is
    // spent on the slots that make the detour off the aisle worth taking.
    const isCovered = (x: number, y: number): boolean => {
      for (let dy = -COVER_REACH; dy <= COVER_REACH; dy += 1)
        for (let dx = -COVER_REACH; dx <= COVER_REACH; dx += 1) {
          const index = mask.indexOf(x + dx, y + dy);
          if (index >= 0 && cover.has(index)) return true;
        }
      return false;
    };
    const exposed: RegionCandidate[] = [];
    const behind: RegionCandidate[] = [];
    for (const candidate of context.candidates) {
      if (context.isReserved(candidate.x, candidate.y)) continue;
      (isCovered(candidate.x, candidate.y) ? behind : exposed).push(candidate);
    }
    let spawned = 0;
    let hidden = 0;
    for (const [rank, candidate] of [...behind, ...exposed].entries()) {
      if (spawned >= context.budget) break;
      if (!standableSlot(mask, blocked, candidate.x, candidate.y)) continue;
      const covered = rank < behind.length;
      const base =
        candidate.lootChance ??
        context.zoneAt(candidate.x, candidate.y).lootChance;
      const weight = covered ? COVER_BONUS : EXPOSED_PENALTY;
      if (!lootRng.chance(clamp01(base * weight))) continue;
      if (!canvas.spawn(candidate.cellIndex, "loot")) continue;
      spawned += 1;
      if (covered) hidden += 1;
    }

    canvas.note("clusters", clusters);
    canvas.note("props", props);
    canvas.note("stubs", stubs);
    canvas.note("loopsRefused", loopsRefused);
    canvas.note("lootBehindCover", hidden);
    return guardRegionEdit(
      context,
      canvas.finish(ID),
      context.clearance.hunter,
    );
  },
};

export default openFieldBuilder;
