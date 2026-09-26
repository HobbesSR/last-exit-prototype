/**
 * `compound` -- grid-aligned buildings on open ground.
 *
 * Buildings are the one place this catalogue is allowed to enclose, and even
 * here enclosure is a reward pocket rather than a filter: the gaps between
 * buildings are streets at least `PASSAGE.wide` across, so nobody is ever made
 * to walk through a room to cross the region. Roughly one room in three gets a
 * second door on the opposite wall, which turns it from a pocket into a
 * through-route; roughly one in four gets a `PASSAGE.squeeze` side entrance,
 * which a contestant may use and a hunter may not. That asymmetry is the point
 * of the squeeze, not an accident of rounding.
 *
 * Siting is exposed separately from declaring (`siteRooms`) because the boxes
 * are the interesting output: tooling that wants to know where the buildings
 * went, and tests that want to measure the streets between them, should not
 * have to recover rectangles from a pile of wall segments.
 */
import { PASSAGE } from "../scale.ts";
import { buildableCells } from "../placement.ts";
import { createCanvas } from "../edit.ts";
import { guardRegionEdit } from "../clearance.ts";
import { SIDES } from "../../primitives.ts";
// Shared with the builders that place props: a street crossing the area is not
// somewhere to put a building, and what must be left alone is one rule.

import type { RegionCanvas } from "../edit.ts";
import type { Box, RegionCandidate, Side } from "../../types.ts";
import type {
  RegionBuilder,
  RegionContext,
  RegionEdit,
  Rng,
  SegmentRef,
} from "../types.ts";

const ID = "compound";

/** Most buildings one region gets, however much room it has. */
const ROOMS_MAX = 4;
/** Room side length, in cells. */
const ROOM_MIN = 3;
const ROOM_MAX = 6;
/**
 * Free cells that must survive between two rooms. Three free cells is a clear
 * span of `PASSAGE.wide`, so the gap is a street two hunters pass abreast in.
 */
const STREET = PASSAGE.wide;
/** How often a room is a through-route, and how often it gets a squeeze door. */
const THROUGH_CHANCE = 1 / 3;
const SQUEEZE_CHANCE = 1 / 4;
/** A window is stated geometry rather than passage: narrower than any body. */
const WINDOW_WIDTH = 0.6;
const WINDOW_CHANCE = 0.5;
/** Interiors are worth entering: a slot inside a room is weighted up this much. */
const INTERIOR_LOOT_BONUS = 2.5;

const OPPOSITE: Record<Side, Side> = { N: "S", S: "N", E: "W", W: "E" };

/** Read a numeric tuning value from the class rule, or take the module default. */
function tuned(context: RegionContext, key: string, fallback: number): number {
  const value = context.rule.generatorParams?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The interior class to paint, when the library named one. Never invented here. */
function interiorClassOf(context: RegionContext): string | undefined {
  const value = context.rule.generatorParams?.interiorClass;
  return typeof value === "string" && value ? value : undefined;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The segments along one side of an inclusive cell box. */
function sideRefs(canvas: RegionCanvas, box: Box, side: Side): SegmentRef[] {
  const [x0, y0, x1, y1] = box;
  const refs: SegmentRef[] = [];
  if (side === "N" || side === "S")
    for (let x = x0; x <= x1; x += 1)
      refs.push(canvas.edgeOf(x, side === "N" ? y0 : y1, side));
  else
    for (let y = y0; y <= y1; y += 1)
      refs.push(canvas.edgeOf(side === "W" ? x0 : x1, y, side));
  return refs;
}

/**
 * The strip of cells behind one side of a box: `length` cells along that side
 * and one cell deep, as centred on the side as it fits.
 */
export function wallStrip(box: Box, side: Side, length: number): Box | null {
  const [x0, y0, x1, y1] = box;
  const along = side === "N" || side === "S" ? x1 - x0 + 1 : y1 - y0 + 1;
  if (along < length) return null;
  const offset = Math.floor((along - length) / 2);
  if (side === "N" || side === "S") {
    const y = side === "N" ? y0 : y1;
    return [x0 + offset, y, x0 + offset + length - 1, y];
  }
  const x = side === "W" ? x0 : x1;
  return [x, y0 + offset, x, y0 + offset + length - 1];
}

/**
 * State one opening of `width` across the run of segments on a named side.
 *
 * `canvas.aperture` states a *centered* span on a single segment, so the widths
 * it can express contiguously are whole segments: 1.5 wants `[0.25, 1]` on one
 * segment and `[0, 0.75]` on the next, and a centered span is never edge
 * aligned. The run arithmetic that does express it lives inside `canvas.room`,
 * so an opening of a fractional width is stated by rooming the strip of cells
 * behind the wall and then putting back the sides of that strip which are
 * interior to the structure. Choosing the side explicitly is the other reason
 * to come this way: `room` weighs every allowed side at once, so asking it for
 * two doors is not the same as asking it for a door on each of two walls.
 *
 * This wants to be `apertureRun(refs, width)` on the canvas; that is a change
 * to a file this builder does not own.
 *
 * Returns the segments the opening was stated across, empty when refused. A
 * caller wants them because `room` walls the whole outline of the strip, and
 * where a strip reaches a corner that outline includes a segment of the wall
 * beside it -- which may already carry an opening worth putting back.
 */
export function runAperture(
  canvas: RegionCanvas,
  strip: Box,
  side: Side,
  width: number,
  _interior: (x: number, y: number) => boolean,
  _rng: Rng,
): SegmentRef[] {
  const refs = sideRefs(canvas, strip, side);
  if (canvas.apertureRun(refs, width)) return refs;
  return [];
}

/** One building, before anything has been declared about it. */
export interface SitedRoom {
  box: Box;
  /** Walls carrying a door. Two, on opposite sides, is a through-route. */
  doorSides: Side[];
  /** The wall carrying a contestant-only entrance, when the room has one. */
  squeezeSide?: Side;
  windows: number;
  /** True when the box sits on the tile lattice in both axes. */
  aligned: boolean;
}

/** True when two boxes have at least `gap` free cells between them in some axis. */
export function boxesApart(a: Box, b: Box, gap: number): boolean {
  return (
    Math.max(b[0] - a[2] - 1, a[0] - b[2] - 1) >= gap ||
    Math.max(b[1] - a[3] - 1, a[1] - b[3] - 1) >= gap
  );
}

/**
 * Where the buildings go. Pure and deterministic in the context seed, and free
 * of the canvas, so a caller may ask the question without making the edit.
 *
 * `mask.interior(2)` is the siting area rather than the whole region: a building
 * flush against a region border would put a wall where the neighbouring region
 * expects open ground, and the two-cell margin is what keeps a compound's
 * geometry its own business.
 */
export function siteRooms(context: RegionContext): SitedRoom[] {
  const { mask, grid } = context;
  const maxRooms = Math.max(1, Math.round(tuned(context, "rooms", ROOMS_MAX)));
  const minSide = Math.max(3, Math.round(tuned(context, "roomMin", ROOM_MIN)));
  const maxSide = Math.max(
    minSide,
    Math.round(tuned(context, "roomMax", ROOM_MAX)),
  );
  const street = tuned(context, "street", STREET);
  const throughChance = tuned(context, "throughChance", THROUGH_CHANCE);
  const squeezeChance = tuned(context, "squeezeChance", SQUEEZE_CHANCE);
  const windowChance = tuned(context, "windowChance", WINDOW_CHANCE);

  const siteRng = context.rng.stream("compound:sites");
  const doorRng = context.rng.stream("compound:doors");

  // Buildable ground is the block minus what another pass owns. Two narrower
  // rules were tried here and both are wrong for a building.
  //
  // `mask.interior(2)` kept a building off the block border, which is only
  // cosmetic -- `fits` already requires every cell of the box to be in the mask
  // -- and it is ruinous in practice: streets and tile anchors punch a hole in
  // every tile, so on real blocks depth-2 collapses to a handful of scattered
  // cells and no 3 x 3 box ever fits. `keepClear` is a rule about where a *prop*
  // may sit, and it excludes the cells beside reserved ground, which is exactly
  // where a building belongs: a wall along a street is the point of a street.
  //
  // Together they sited zero buildings on an entire 936-tile map while
  // reporting no refusals at all, because a site that is never found is never
  // refused.
  const interior = buildableCells(context);
  const fits = (box: Box): boolean => {
    for (let y = box[1]; y <= box[3]; y += 1)
      for (let x = box[0]; x <= box[2]; x += 1) {
        const index = mask.indexOf(x, y);
        if (index < 0 || !interior.has(index)) return false;
      }
    return true;
  };

  // A maximal rectangle is a poor siting unit on its own: a region with no
  // hole in it has exactly one, which would site exactly one building. So the
  // rectangles only say where there is room at all, and the origins are walked
  // inside them -- tile-aligned corners first, because a building on the tile
  // lattice reads as built and composes with what the seam carries.
  const spots: Array<{ x: number; y: number; aligned: boolean }> = [];
  const seen = new Set<number>();
  for (const rect of mask.rects(minSide, minSide))
    for (let y = rect[1]; y + minSide - 1 <= rect[3]; y += 1)
      for (let x = rect[0]; x + minSide - 1 <= rect[2]; x += 1) {
        const index = y * mask.width + x;
        if (seen.has(index)) continue;
        seen.add(index);
        spots.push({
          x,
          y,
          aligned: x % grid.tileSize === 0 && y % grid.tileSize === 0,
        });
      }
  const ordered = [
    ...siteRng.shuffle(spots.filter((spot) => spot.aligned)),
    ...siteRng.shuffle(spots.filter((spot) => !spot.aligned)),
  ];

  const rooms: SitedRoom[] = [];
  for (const spot of ordered) {
    if (rooms.length >= maxRooms) break;
    const w = siteRng.int(minSide, maxSide);
    const h = siteRng.int(minSide, maxSide);
    // The drawn size first, then the smallest room, so a spot with a big
    // neighbour still gets a building rather than nothing.
    for (const size of [
      [w, h],
      [minSide, minSide],
    ]) {
      const box: Box = [
        spot.x,
        spot.y,
        spot.x + size[0]! - 1,
        spot.y + size[1]! - 1,
      ];
      if (!fits(box)) continue;
      if (rooms.some((room) => !boxesApart(room.box, box, street))) continue;

      const first = SIDES[doorRng.int(0, SIDES.length - 1)]!;
      const doorSides: Side[] = doorRng.chance(throughChance)
        ? [first, OPPOSITE[first]]
        : [first];
      const spare = SIDES.filter((side) => !doorSides.includes(side));
      const squeezeSide = doorRng.chance(squeezeChance)
        ? spare[doorRng.int(0, spare.length - 1)]
        : undefined;
      rooms.push({
        box,
        doorSides,
        squeezeSide,
        windows: doorRng.chance(windowChance) ? 1 : 0,
        aligned: spot.aligned,
      });
      break;
    }
  }
  return rooms;
}

export const compoundBuilder: RegionBuilder = {
  id: ID,
  description:
    "Grid-aligned rooms with doors, windows and contestant-only side entrances, streets between them.",
  minArea: 36,
  build(context: RegionContext): RegionEdit {
    const canvas = createCanvas(context);
    const rooms = siteRooms(context);
    const interiorClass = interiorClassOf(context);
    const lootRng = context.rng.stream("compound:loot");

    let placed = 0;
    let doors = 0;
    let squeezes = 0;
    let windows = 0;
    let through = 0;
    for (const [index, room] of rooms.entries()) {
      const [x0, y0, x1, y1] = room.box;
      const inside = (x: number, y: number): boolean =>
        x >= x0 && x <= x1 && y >= y0 && y <= y1;
      // The first door comes from `room` itself, which is also what states the
      // walls, the windows and the interior class.
      const result = canvas.room(room.box, {
        doors: 1,
        doorWidth: PASSAGE.door,
        windows: room.windows,
        windowWidth: WINDOW_WIDTH,
        interiorClass,
        sides: [room.doorSides[0]!],
        rng: context.rng.stream(`compound:room:${index}`),
      });
      if (!result.placed) continue;
      placed += 1;
      doors += 1;
      windows += room.windows;
      const wide = [...result.doors];

      for (const side of room.doorSides.slice(1)) {
        const strip = wallStrip(room.box, side, Math.ceil(PASSAGE.door));
        if (!strip) continue;
        const stated = runAperture(
          canvas,
          strip,
          side,
          PASSAGE.door,
          inside,
          context.rng.stream(`compound:through:${index}`),
        );
        if (!stated.length) continue;
        wide.push(...stated);
        doors += 1;
        through += 1;
      }
      // The squeeze is stated last because its spans are the fractional ones,
      // and then every full-width door is stated again: a strip that reached a
      // corner walled one segment of the wall beside it on its way past, and a
      // door two whole segments wide is exactly what `open` can put back.
      if (room.squeezeSide) {
        const strip = wallStrip(
          room.box,
          room.squeezeSide,
          Math.ceil(PASSAGE.squeeze),
        );
        if (
          strip &&
          runAperture(
            canvas,
            strip,
            room.squeezeSide,
            PASSAGE.squeeze,
            inside,
            context.rng.stream(`compound:squeeze:${index}`),
          ).length
        )
          squeezes += 1;
      }
      for (const ref of wide) canvas.open(ref);
      for (let y = y0; y <= y1; y += 1)
        for (let x = x0; x <= x1; x += 1) canvas.claim(x, y);
    }

    // Interiors are loot-dense: a room you can walk past is not worth entering.
    const insideAny = (candidate: RegionCandidate): boolean =>
      rooms.some(
        ({ box }) =>
          candidate.x >= box[0] &&
          candidate.x <= box[2] &&
          candidate.y >= box[1] &&
          candidate.y <= box[3],
      );
    const interior: RegionCandidate[] = [];
    const outside: RegionCandidate[] = [];
    for (const candidate of context.candidates) {
      if (context.isReserved(candidate.x, candidate.y)) continue;
      (insideAny(candidate) ? interior : outside).push(candidate);
    }
    let spawned = 0;
    for (const [rank, candidate] of [...interior, ...outside].entries()) {
      if (spawned >= context.budget) break;
      const base =
        candidate.lootChance ??
        context.zoneAt(candidate.x, candidate.y).lootChance;
      const weight = rank < interior.length ? INTERIOR_LOOT_BONUS : 1;
      if (!lootRng.chance(clamp01(base * weight))) continue;
      if (canvas.spawn(candidate.cellIndex, "loot")) spawned += 1;
    }

    canvas.note("rooms", placed);
    canvas.note("doors", doors);
    canvas.note("throughRooms", through);
    canvas.note("squeezeEntrances", squeezes);
    canvas.note("windows", windows);
    canvas.note("alignedRooms", rooms.filter((room) => room.aligned).length);
    return guardRegionEdit(
      context,
      canvas.finish(ID),
      context.clearance.hunter,
    );
  },
};

export default compoundBuilder;
