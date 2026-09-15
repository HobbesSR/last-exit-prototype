/**
 * `courtyard` -- the reward pocket.
 *
 * Enclosure is the exception in this catalogue and is never a filter you must
 * pass through to get anywhere: a courtyard is somewhere you choose to go into.
 * Its own border is walled and two or three gates are left in it -- one at
 * `PASSAGE.door`, the rest at `PASSAGE.squeeze`, so a contestant has a way in
 * that the hunter behind them cannot take. The middle is left largely empty
 * with a little cover, and a `set-piece` feature is sited at the centroid so a
 * macro pass has an obvious place to hang a charger.
 *
 * Gates are chosen from `context.openings`, which is the only honest place to
 * choose them: those segments are where the region actually meets the rest of
 * the map, so a gate anywhere else would be a hole into a neighbour that never
 * agreed to one, and a gate that is not an opening leaves the pocket sealed. An
 * opening no route may lose (`required`) is always a gate and is never narrowed.
 * The canvas would refuse to seal one anyway; not relying on that is the point.
 *
 * A gate is a *run* of adjacent openings rather than one segment, because one
 * segment is at most one unit open and no body in the brief is that thin.
 */
import { PASSAGE } from "../scale.ts";
import { createCanvas } from "../edit.ts";
import { guardRegionEdit } from "../clearance.ts";
// Shared with the other builders that place props rather than copied: what
// makes a cell standing room is one rule, and it is the open-field builder that
// first needed it.
import { PROP_MARGIN, keepClear, standableSlot } from "../placement.ts";
// `runAperture` belongs on the canvas as `apertureRun`; until it can live in
// edit.ts, the catalogue keeps one implementation rather than two copies.
import { runAperture } from "./compound.ts";
import { SIDES } from "../../primitives.ts";
import type { Box, Side } from "../../types.ts";
import type {
  RegionBuilder,
  RegionContext,
  RegionEdit,
  RegionOpening,
  SegmentRef,
} from "../types.ts";

const ID = "courtyard";

/** Gates left in the wall. Two or three: fewer is a trap, more is a field. */
const GATES_MIN = 2;
const GATES_MAX = 3;
/** Props of cover near the middle, and how far from the centroid they may sit. */
const COVER_PROPS = 3;
const COVER_RADIUS = 2;
const PROP_LENGTH = 0.6;
/** What the macro pass is being offered somewhere to hang. */
const FEATURE_KIND = "set-piece";

/** Read a numeric tuning value from the class rule, or take the module default. */
function tuned(context: RegionContext, key: string, fallback: number): number {
  const value = context.rule.generatorParams?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const refKey = (ref: SegmentRef): string =>
  `${ref.vertical ? "v" : "h"}:${ref.line}:${ref.offset}`;

/** Which way out of the region an opening faces. */
function sideOf(opening: RegionOpening): Side {
  const dx = opening.outside.x - opening.inside.x;
  if (dx !== 0) return dx < 0 ? "W" : "E";
  return opening.outside.y - opening.inside.y < 0 ? "N" : "S";
}

/**
 * Maximal runs of adjacent collinear openings, in a deterministic order. A run
 * is what a gate is measured in: two adjacent segments are a `PASSAGE.door`,
 * and a lone one is a slot nothing walks through.
 */
export function openingRuns(
  openings: readonly RegionOpening[],
): RegionOpening[][] {
  const lines = new Map<string, RegionOpening[]>();
  for (const opening of openings) {
    const key = `${opening.vertical ? "v" : "h"}:${opening.line}:${sideOf(opening)}`;
    const bucket = lines.get(key);
    if (bucket) bucket.push(opening);
    else lines.set(key, [opening]);
  }
  const runs: RegionOpening[][] = [];
  for (const key of [...lines.keys()].sort()) {
    const sorted = lines
      .get(key)!
      .slice()
      .sort((a, b) => a.offset - b.offset);
    let run: RegionOpening[] = [];
    for (const opening of sorted) {
      const last = run[run.length - 1];
      if (last && opening.offset !== last.offset + 1) {
        runs.push(run);
        run = [];
      }
      run.push(opening);
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

export const courtyardBuilder: RegionBuilder = {
  id: ID,
  description:
    "A walled pocket with two or three gates, one of them contestant-only, and a set-piece in the middle.",
  minArea: 25,
  build(context: RegionContext): RegionEdit {
    const canvas = createCanvas(context);
    const { mask } = context;
    const gateRng = context.rng.stream("courtyard:gates");
    const coverRng = context.rng.stream("courtyard:cover");
    const lootRng = context.rng.stream("courtyard:loot");

    // Gates are settled before a single wall is stated, so the border pass can
    // leave them alone rather than state a wall and take it back.
    const wanted = Math.min(
      GATES_MAX,
      Math.max(
        1,
        Math.round(tuned(context, "gates", gateRng.int(GATES_MIN, GATES_MAX))),
      ),
    );
    const runs = openingRuns(context.openings);
    const demanded = runs.filter((run) => run.some((one) => one.required));
    const spare = gateRng.shuffle(
      runs.filter((run) => !demanded.includes(run)),
    );
    const gates = [
      ...demanded,
      ...spare.slice(0, Math.max(0, wanted - demanded.length)),
    ];

    // Two segments is a door; the run may be wider than that, and the surplus
    // is walled so a gate is a gate rather than a missing side.
    const doorRun = Math.ceil(PASSAGE.door);
    const used = new Map<string, RegionOpening[]>();
    for (const [index, run] of gates.entries())
      used.set(String(index), run.slice(0, Math.min(doorRun, run.length)));
    const spared = new Set([...used.values()].flat().map(refKey));

    // Walling the border: the bounding box outline when the region fills it,
    // and the region's own border cells when it does not. A region is an
    // arbitrary shape and usually is not its own bounding box.
    const [bx0, by0, bx1, by1] = mask.bounds;
    const rectangular = mask.area === (bx1 - bx0 + 1) * (by1 - by0 + 1);
    const border: SegmentRef[] = rectangular
      ? canvas.outline(mask.bounds)
      : mask.border().flatMap((cell) =>
          SIDES.flatMap((side: Side) => {
            const dx = side === "W" ? -1 : side === "E" ? 1 : 0;
            const dy = side === "N" ? -1 : side === "S" ? 1 : 0;
            if (mask.has(cell.x + dx, cell.y + dy)) return [];
            return [canvas.edgeOf(cell.x, cell.y, side)];
          }),
        );
    const requiredKeys = new Set(
      context.openings.filter((one) => one.required).map(refKey),
    );

    let walls = 0;
    for (const ref of border) {
      const key = refKey(ref);
      if (spared.has(key) || requiredKeys.has(key)) continue;
      if (canvas.wall(ref)) walls += 1;
    }

    // The widest gate is the door; the rest are contestant-only where the run
    // allows one to be stated, which is what makes the pocket a reward for the
    // body that fits rather than a room with a door in it.
    let doors = 0;
    let squeezes = 0;
    const wide: SegmentRef[] = [];
    const insideRegion = (x: number, y: number): boolean => mask.has(x, y);
    for (const [index, run] of gates.entries()) {
      const segments = used.get(String(index))!;
      const side = sideOf(segments[0]!);
      const asSqueeze =
        index > 0 &&
        segments.length >= doorRun &&
        !run.some((one) => one.required);
      if (asSqueeze) {
        const cells = segments.map((one) => one.inside);
        const strip: Box = [
          Math.min(...cells.map((c) => c.x)),
          Math.min(...cells.map((c) => c.y)),
          Math.max(...cells.map((c) => c.x)),
          Math.max(...cells.map((c) => c.y)),
        ];
        if (
          runAperture(
            canvas,
            strip,
            side,
            PASSAGE.squeeze,
            insideRegion,
            context.rng.stream(`courtyard:squeeze:${index}`),
          ).length
        ) {
          squeezes += 1;
          continue;
        }
      }
      let opened = 0;
      for (const segment of segments) if (canvas.open(segment)) opened += 1;
      if (opened) {
        doors += 1;
        wide.push(...segments);
      }
    }
    // A squeeze strip that reached the end of its run walled the segment beside
    // it on the way past, which may have been another gate. Whole segments are
    // what `open` can put back, so the door gates are stated again.
    for (const ref of wide) canvas.open(ref);

    // The middle. A centroid cell of the region, snapped to a cell the region
    // actually has, because a courtyard is not always convex.
    const cells = mask.cells;
    let sumX = 0;
    let sumY = 0;
    for (const cell of cells) {
      sumX += cell.x;
      sumY += cell.y;
    }
    const targetX = sumX / cells.length;
    const targetY = sumY / cells.length;
    let centre = cells[0]!;
    let best = Infinity;
    for (const cell of cells) {
      if (context.isReserved(cell.x, cell.y)) continue;
      const distance =
        (cell.x - targetX) * (cell.x - targetX) +
        (cell.y - targetY) * (cell.y - targetY);
      if (distance < best) {
        best = distance;
        centre = cell;
      }
    }
    const feature = canvas.feature(FEATURE_KIND, centre.x, centre.y) ? 1 : 0;
    if (feature) canvas.claim(centre.x, centre.y);

    // A little cover near the middle: enough that the set-piece is not taken
    // standing in the open, nowhere near enough to make the pocket a maze.
    const keep = keepClear(context);
    const ring: Array<{ x: number; y: number }> = [];
    for (let dy = -COVER_RADIUS; dy <= COVER_RADIUS; dy += 1)
      for (let dx = -COVER_RADIUS; dx <= COVER_RADIUS; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== COVER_RADIUS) continue;
        const x = centre.x + dx;
        const y = centre.y + dy;
        const index = mask.indexOf(x, y);
        if (index < 0 || context.isReserved(x, y) || keep.has(index)) continue;
        // Cover keeps its distance from the wall for the same reason a prop
        // does anywhere else: a body has to be able to walk past it.
        if (mask.depthAt(x, y) < PROP_MARGIN) continue;
        ring.push({ x, y });
      }
    const propLength = tuned(context, "propLength", PROP_LENGTH);
    const wantedProps = Math.round(tuned(context, "coverProps", COVER_PROPS));
    /** Cells a prop sits in: cover for the set-piece, and nowhere to stand. */
    const blocked = new Set<number>();
    let props = 0;
    for (const cell of coverRng.shuffle(ring).slice(0, wantedProps)) {
      if (canvas.isClaimed(cell.x, cell.y)) continue;
      const angle = coverRng.next() * Math.PI * 2;
      if (!canvas.propInCell(cell.x, cell.y, propLength, angle)) continue;
      canvas.claim(cell.x, cell.y);
      blocked.add(mask.indexOf(cell.x, cell.y));
      props += 1;
    }

    let spawned = 0;
    for (const candidate of context.candidates) {
      if (spawned >= context.budget) break;
      if (context.isReserved(candidate.x, candidate.y)) continue;
      if (!standableSlot(mask, blocked, candidate.x, candidate.y)) continue;
      const base =
        candidate.lootChance ??
        context.zoneAt(candidate.x, candidate.y).lootChance;
      if (!lootRng.chance(base)) continue;
      if (canvas.spawn(candidate.cellIndex, "loot")) spawned += 1;
    }

    canvas.note("gates", doors + squeezes);
    canvas.note("doorGates", doors);
    canvas.note("squeezeGates", squeezes);
    canvas.note("borderWalls", walls);
    canvas.note("setPieces", feature);
    canvas.note("coverProps", props);
    return guardRegionEdit(
      context,
      canvas.finish(ID),
      context.clearance.hunter,
    );
  },
};

export default courtyardBuilder;
