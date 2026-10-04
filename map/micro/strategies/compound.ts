import { buildOpen } from './open.ts';
import { largestRectangle } from './hall.ts';
import { cellLoot, draw } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import { splitBuilding } from '../building/pieces.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { Shape } from '../../../shared/shape.ts';
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
/** A gate's passage through the ring: a doorway (52). */
const PASSAGE = CELL_SCALE.doorway;

type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Per-side draw channels, so no choice shifts another. */
const CHANNEL = { offset: 1, gateSide: 2, gateAt: 3, room: 4, loot: 5 };

/** A box in the compound's own cells. */
interface Box { x: number; y: number; w: number; h: number }

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
export function buildCompound(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
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

  // The ring in the box's own cells. A side's middle runs between the corner rooms; `strip` is the box `length` long from `t` along it, `DEPTH` deep.
  const strip = (side: Side, t: number, length: number): Box => {
    switch (side) {
      case 'N': return { x: DEPTH + t, y: 0, w: length, h: DEPTH };
      case 'S': return { x: DEPTH + t, y: H - DEPTH, w: length, h: DEPTH };
      case 'W': return { x: 0, y: DEPTH + t, w: DEPTH, h: length };
      case 'E': return { x: W - DEPTH, y: DEPTH + t, w: DEPTH, h: length };
    }
  };
  const rooms: { id: string; box: Box; side?: Side }[] = [
    { id: 'room-1', box: { x: 0, y: 0, w: DEPTH, h: DEPTH } }, { id: 'room-2', box: { x: W - DEPTH, y: 0, w: DEPTH, h: DEPTH } },
    { id: 'room-3', box: { x: 0, y: H - DEPTH, w: DEPTH, h: DEPTH } }, { id: 'room-4', box: { x: W - DEPTH, y: H - DEPTH, w: DEPTH, h: DEPTH } },
  ];
  const passages: { id: string; box: Box; side: Side }[] = [];
  for (const [i, side] of SIDES.entries()) {
    const middle = (side === 'N' || side === 'S' ? W : H) - 2 * DEPTH;
    // A gate's passage is PASSAGE wide at a seeded place, widened to the corner where what's left is too short for a room.
    let segments: [number, number][] = [[0, middle]];
    if (gated.has(side)) {
      let a = Math.floor(draw(brief.seed, i, 1, CHANNEL.gateAt) * (middle - PASSAGE + 1)), b = a + PASSAGE;
      if (a < MIN_ROOM) a = 0;
      if (middle - b < MIN_ROOM) b = middle;
      passages.push({ id: `gate-${side}`, box: strip(side, a, b - a), side });
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
        rooms.push({ id: `room-${rooms.length + 1}`, box: strip(side, t0, t1 - t0), side });
      }
    }
  }
  const cellsOf = ({ x, y, w, h }: Box) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
  const spaces = [...rooms, ...passages];
  const allocation: BuildingAllocation = { footprint: spaces.flatMap(s => cellsOf(s.box)), spaces: spaces.map(s => ({ id: s.id, cells: cellsOf(s.box) })) };
  const at = (x: number, y: number) => spaces.find(({ box }) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)!.id;
  const widths: Record<string, number> = {};
  const design: BuildingDesign = {
    spaces: spaces.map(({ id, box }) => ({ id, area: { min: box.w * box.h, max: box.w * box.h }, outside: 'any',
      tags: [id.startsWith('gate') ? 'passage' : 'room'] })),
    connections: [
      // Each side's rooms open onto the court; each corner room only into its neighbour along the north or south side.
      ...rooms.filter(room => room.side).map(room => ({ id: `${room.id}-court`, a: room.id, b: OUTSIDE, kind: 'door' as const, side: OPPOSITE[room.side!] })),
      { id: 'room-1-door', a: 'room-1', b: at(DEPTH, 0), kind: 'door' }, { id: 'room-2-door', a: 'room-2', b: at(W - DEPTH - 1, 0), kind: 'door' },
      { id: 'room-3-door', a: 'room-3', b: at(DEPTH, H - 1), kind: 'door' }, { id: 'room-4-door', a: 'room-4', b: at(W - DEPTH - 1, H - 1), kind: 'door' },
      // A passage has a door in the outer wall and lies open to the court along its whole length.
      ...passages.flatMap(({ id, box, side }) => {
        widths[`${id}-court`] = side === 'N' || side === 'S' ? box.w : box.h;
        return [{ id, a: id, b: OUTSIDE, kind: 'door' as const, side }, { id: `${id}-court`, a: id, b: OUTSIDE, kind: 'open' as const, side: OPPOSITE[side] }];
      }),
    ],
  };
  const realization = realizeBuilding(design, allocation, { cellSize: size, thickness: WALL, encloses: false, exteriorOrder: SIDES, corners: 'horizontal', clear: passages.map(passage => passage.id), widths });
  const split = realization.template && splitBuilding(realization, allocation, { cellSize: size, roofed: rooms.map(room => room.id) });
  // The ring's design always fits. A miss here is an implementation defect, not a new fallback.
  if (!split || realization.issues.length || realization.misses.length || split.issues.length) throw new Error('The compound ring could not be realized.');
  observe?.({ label: 'compound', origin: { x: bx * size, y: by * size }, cellSize: size, design, allocation, realization });

  const elements: RegionElement[] = split.pieces.map(piece => ({ label: `compound-${piece.space}`,
    x: bx * size + piece.origin.x, y: by * size + piece.origin.y, template: piece.template }));
  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: rooms.length, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, rooms: rooms.length, compoundGates: passages.length } };
}
