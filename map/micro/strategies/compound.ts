import { buildOpen } from './open.ts';
import { largestRectangle } from './hall.ts';
import { cellLoot, draw } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { rect } from '../../../shared/shape.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/** The catalogue's proposed shape need (54): the compound at least this many cells a side, so its court is at least 4. */
const MIN_SIDE = 10;
/** The compound's sides are capped, so an enormous region holds one compound in a wide yard. */
const MAX_SIDE = 24;
/**
 * Clear cells around the compound, to any cell the region doesn't own, as `depot` keeps around
 * a warehouse once did. It is the compound's own yard margin (54), a doorway and a cell.
 */
const AISLE = 3;
/** How deep the ring of rooms is, in cells: a hunter fits inside, between quarter-cell walls. */
const DEPTH = 3;
/** The least length of a room along its side, in cells, and the range a side's rooms aim for. */
const MIN_ROOM = 3, MAX_ROOM = 5;
const MIN_GATES = 1, MAX_GATES = 4, DEFAULT_GATES = 2;
/** Wall thickness, in cells, as `hut`'s are. */
const WALL = 0.25;
const DOOR = CELL_SCALE.doorway;
/** A gate's passage through the ring: a doorway (52). */
const PASSAGE = DOOR;

type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Per-side draw channels, so no choice shifts another. */
const CHANNEL = { offset: 1, gateSide: 2, gateAt: 3, room: 4, loot: 5 };

/** A doorway in a room's wall: its side, its centre along that wall in cells, and whether this room holds its door. */
interface Doorway { side: Side; at: number; door: boolean }
interface Room { x: number; y: number; w: number; h: number; doorways: Doorway[] }

/**
 * The `compound` region type (54): rooms in a ring around a walled court, with a few gates.
 * A pocket that rewards a contestant who knows its gates and traps one who doesn't. It has no
 * decomposer.
 *
 * One compound stands in the region's largest contained rectangle, inset `AISLE` cells and
 * capped at `MAX_SIDE`, at a seeded place. Its outer edge is the back wall of a ring of roofed
 * rooms `DEPTH` cells deep, with a square room at each corner. Each side's rooms open
 * onto the court. Each corner room opens only into its neighbour along the north or south
 * side, a room or a passage, so it is a dead end. `gates` sides, drawn from the seed, have a passage through the ring from a gate
 * in the outer wall to the court.
 *
 * The compound is a convex box with a clear ring wider than a hunter around it, so it can't
 * divide the yard a hunter can reach outside it, where every portal is. So, like `depot`, the
 * region keeps the portal promise exactly when its shape does. A region with no contained
 * square of `MIN_SIDE` plus the aisle on each side goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every wall and door, in the rooms, the court or the yard. A compound sites no core elements;
 * any the brief lists are left for the report.
 */
export function buildCompound(brief: RegionBrief): BuiltRegion {
  const gates = brief.parameters?.gates ?? DEFAULT_GATES;
  if (typeof gates !== 'number' || !Number.isInteger(gates) || gates < MIN_GATES || gates > MAX_GATES)
    throw new RangeError(`Compound gates must be a whole number from ${MIN_GATES} to ${MAX_GATES}.`);
  const mask = createRegionMask(brief), size = brief.cellSize;
  const space = largestRectangle(mask, MIN_SIDE + 2 * AISLE);
  if (!space) return buildOpen(brief);

  // The compound's box in cells, at a seeded place inside the aisle. The rectangle is in cells too.
  const sx = space.x + AISLE, sy = space.y + AISLE, sw = space.w - 2 * AISLE, sh = space.h - 2 * AISLE;
  const W = Math.min(sw, MAX_SIDE), H = Math.min(sh, MAX_SIDE);
  const bx = sx + Math.floor(draw(brief.seed, 0, 0, CHANNEL.offset) * (sw - W + 1));
  const by = sy + Math.floor(draw(brief.seed, 0, 1, CHANNEL.offset) * (sh - H + 1));

  const gated = new Set([...SIDES].map((side, i) => ({ side, order: draw(brief.seed, i, 0, CHANNEL.gateSide) }))
    .sort((a, b) => a.order - b.order).slice(0, gates).map(({ side }) => side));

  // A side's middle runs between the corner rooms. `strip` is the box `length` long from `t` along it, `DEPTH` deep.
  const strip = (side: Side, t: number, length: number): Room => {
    switch (side) {
      case 'N': return { x: bx + DEPTH + t, y: by, w: length, h: DEPTH, doorways: [] };
      case 'S': return { x: bx + DEPTH + t, y: by + H - DEPTH, w: length, h: DEPTH, doorways: [] };
      case 'W': return { x: bx, y: by + DEPTH + t, w: DEPTH, h: length, doorways: [] };
      case 'E': return { x: bx + W - DEPTH, y: by + DEPTH + t, w: DEPTH, h: length, doorways: [] };
    }
  };
  const rooms: Room[] = [], passages: { side: Side; box: Room }[] = [];
  // The rooms at each end of a side's middle, beside the corner rooms. A passage may take an end instead.
  const firsts = new Map<Side, Room>(), lasts = new Map<Side, Room>();
  for (const [i, side] of SIDES.entries()) {
    const middle = (side === 'N' || side === 'S' ? W : H) - 2 * DEPTH;
    // A gate's passage is PASSAGE wide at a seeded place, widened to the corner where what's left is too short for a room.
    let segments: [number, number][] = [[0, middle]];
    if (gated.has(side)) {
      let a = Math.floor(draw(brief.seed, i, 1, CHANNEL.gateAt) * (middle - PASSAGE + 1)), b = a + PASSAGE;
      if (a < MIN_ROOM) a = 0;
      if (middle - b < MIN_ROOM) b = middle;
      passages.push({ side, box: strip(side, a, b - a) });
      segments = [[0, a], [b, middle]];
    }
    const aim = MIN_ROOM + Math.floor(draw(brief.seed, i, 2, CHANNEL.room) * (MAX_ROOM - MIN_ROOM + 1));
    for (const [from, to] of segments) {
      const span = to - from;
      if (!span) continue;
      // Lengths as even as whole cells allow, each at least MIN_ROOM.
      const count = Math.max(1, Math.min(Math.floor(span / MIN_ROOM), Math.round(span / aim)));
      for (let k = 0; k < count; k++) {
        const t0 = from + Math.floor(span * k / count), t1 = from + Math.floor(span * (k + 1) / count);
        const room = strip(side, t0, t1 - t0);
        room.doorways.push({ side: OPPOSITE[side], at: (t1 - t0) / 2, door: true });
        if (t0 === 0) firsts.set(side, room);
        if (t1 === middle) lasts.set(side, room);
        rooms.push(room);
      }
    }
  }
  // Corner rooms open along the north or south side, into its end room or its passage.
  const corners: Room[] = [
    { x: bx, y: by, w: DEPTH, h: DEPTH, doorways: [{ side: 'E', at: DEPTH / 2, door: true }] },
    { x: bx + W - DEPTH, y: by, w: DEPTH, h: DEPTH, doorways: [{ side: 'W', at: DEPTH / 2, door: true }] },
    { x: bx, y: by + H - DEPTH, w: DEPTH, h: DEPTH, doorways: [{ side: 'E', at: DEPTH / 2, door: true }] },
    { x: bx + W - DEPTH, y: by + H - DEPTH, w: DEPTH, h: DEPTH, doorways: [{ side: 'W', at: DEPTH / 2, door: true }] },
  ];
  firsts.get('N')?.doorways.push({ side: 'W', at: DEPTH / 2, door: false });
  lasts.get('N')?.doorways.push({ side: 'E', at: DEPTH / 2, door: false });
  firsts.get('S')?.doorways.push({ side: 'W', at: DEPTH / 2, door: false });
  lasts.get('S')?.doorways.push({ side: 'E', at: DEPTH / 2, door: false });

  const elements: RegionElement[] = [];
  for (const [k, room] of [...corners, ...rooms].entries())
    elements.push({ label: `compound-room-${k + 1}`, x: room.x * size, y: room.y * size, template: roomTemplate(size, room) });
  for (const { side, box } of passages)
    elements.push({ label: `compound-gate-${side}`, x: box.x * size, y: box.y * size, template: gateTemplate(size, side, box) });

  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  const roomCount = corners.length + rooms.length;
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: roomCount, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, rooms: roomCount, compoundGates: passages.length } };
}

/**
 * A room `w` × `h` cells: quarter-cell walls on its box's edge, north and south running the
 * full width and east and west between them, each with its doorways a doorway wide. A doorway
 * the room holds the door of gets a gate. It encloses, so it has a roof.
 */
function roomTemplate(size: number, { w, h, doorways }: Room): ElementTemplate {
  const parts: ElementTemplate['parts'] = [];
  for (const side of SIDES) {
    const horizontal = side === 'N' || side === 'S';
    const from = horizontal ? 0 : WALL, to = horizontal ? w : h - WALL, across = side === 'N' ? 0 : side === 'S' ? h - WALL : side === 'W' ? 0 : w - WALL;
    const piece = (a: number, b: number): Shape => horizontal ? rect(a * size, across * size, (b - a) * size, WALL * size) : rect(across * size, a * size, WALL * size, (b - a) * size);
    let at = from;
    for (const { at: centre } of doorways.filter(d => d.side === side).sort((a, b) => a.at - b.at)) {
      if (centre - DOOR / 2 > at) parts.push({ part: 'obstacle', shape: piece(at, centre - DOOR / 2), kind: 'building' });
      at = centre + DOOR / 2;
    }
    if (to > at) parts.push({ part: 'obstacle', shape: piece(at, to), kind: 'building' });
  }
  for (const { side, at } of doorways.filter(d => d.door)) {
    const edge = side === 'N' || side === 'W' ? WALL / 2 : (side === 'S' ? h : w) - WALL / 2;
    parts.push(side === 'N' || side === 'S' ? { part: 'gate', x: at * size, y: edge * size, w: DOOR * size, h: WALL * size }
      : { part: 'gate', x: edge * size, y: at * size, w: WALL * size, h: DOOR * size });
  }
  return { w: w * size, h: h * size, encloses: true, parts };
}

/** A gate at a passage's mouth: the outer wall either side of it, and a door a doorway wide near its middle. Open to the sky. */
function gateTemplate(size: number, side: Side, { w, h }: Room): ElementTemplate {
  const horizontal = side === 'N' || side === 'S', length = horizontal ? w : h;
  const across = side === 'N' || side === 'W' ? 0 : (horizontal ? h : w) - WALL, centre = length / 2;
  const piece = (a: number, b: number): Shape => horizontal ? rect(a * size, across * size, (b - a) * size, WALL * size) : rect(across * size, a * size, WALL * size, (b - a) * size);
  const parts: ElementTemplate['parts'] = [];
  if (centre - DOOR / 2 > 0) parts.push({ part: 'obstacle', shape: piece(0, centre - DOOR / 2), kind: 'building' });
  if (length > centre + DOOR / 2) parts.push({ part: 'obstacle', shape: piece(centre + DOOR / 2, length), kind: 'building' });
  const edge = (across + WALL / 2) * size;
  parts.push(horizontal ? { part: 'gate', x: centre * size, y: edge, w: DOOR * size, h: WALL * size }
    : { part: 'gate', x: edge, y: centre * size, w: WALL * size, h: DOOR * size });
  return { w: w * size, h: h * size, parts };
}
