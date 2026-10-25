import { compareCells } from '../../kernel/cell.ts';
import { polygon, rect } from '../../../shared/shape.ts';
import { FALLEN_SLAB } from '../placeables/fallen-slab.ts';
import { RUIN_ROOM_SPAN } from '../placeables/ruin-room-span.ts';
import { expectPlaced } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createFillMask, createRegionMask } from '../geometry.ts';
import { commitHintWalls, wallHints } from '../hint-walls.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { disjoint } from '../../../shared/shape-construction.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';
import { builtRegion } from '../result.ts';

const DEFAULT_DENSITY = 0.7;
const DEFAULT_DECAY = 0.35;
/** Cells between room slots. A room is 3 or 4 cells, so at least a doorway-wide alley (52) parts two rooms. */
const PERIOD = 6;
/** A wall is a quarter cell thick, as `hut`'s are. */
const WALL = 0.25;
/** The catalogue's proposed shape need (54). */
const MIN_CELLS = 24;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { slot: 1, width: 2, height: 3, door: 4, doorAt: 5, loot: 6, phase: 7, span: 10, debris: 20, angle: 30, size: 40 };
/** The four sides of a room, in the order their channels are offset by. */
const SIDES = ['north', 'east', 'south', 'west'] as const;
type Side = typeof SIDES[number];

/**
 * The `ruins` region type (54): roofless rooms with broken walls, and their fallen spans as
 * rotated debris. It has no decomposer.
 *
 * Room slots lie on a lattice `PERIOD` cells apart, at a seeded phase. A slot is taken with
 * chance `density` by a room of 3 or 4 cells a side, wholly on owned cells. Its walls are
 * laid a cell at a time along the inside of its box. One side, where the cells beyond are
 * owned, has a doorway two cells wide, so nothing inside is sealed off. Every other span
 * falls with chance `decay`: half of those lie as a rotated slab of debris on their cell,
 * and the rest are gone.
 *
 * Portal approaches and one hunter route between portals are protected in the empty shape
 * before any piece is laid, and a piece that would touch them is left out, as `rubble` does.
 * Then plain walls stand along every hinted run where no piece or route is (`wallHints`).
 * So the region keeps the portal promise whenever its shape does. A region smaller than
 * `MIN_CELLS`, or with no owned 3 × 3 box for a room, goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear
 * of every piece. Ruins site no core elements; any the brief lists are left for the report.
 */
export function buildRuins(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Ruins', 'density', DEFAULT_DENSITY);
  const decay = fraction(brief, 'Ruins', 'decay', DEFAULT_DECAY);
  const mask = createFillMask(brief), size = brief.cellSize;
  if (mask.cells.length < MIN_CELLS || !mask.rectangles(3, 3).length) return unfilledRegion(brief, CHANNEL.loot);

  const protectedShapes = protectedRoutes(brief, 'Ruins');
  const phase = { x: Math.floor(draw(brief.seed, 0, 0, CHANNEL.phase) * PERIOD), y: Math.floor(draw(brief.seed, 1, 0, CHANNEL.phase) * PERIOD) };
  const onLattice = (value: number, offset: number) => ((value - offset) % PERIOD + PERIOD) % PERIOD === 0;
  const owns = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (!mask.has(i, j)) return false;
    return true;
  };

  const canvas = createBuilderCanvas(brief, protectedShapes);
  // A room's laid spans and their shapes, committed together once it is done: spans meet at its corners.
  let room: RegionElement[] = [], roomShapes: Shape[] = [];
  const pieces: Shape[] = [];
  let rooms = 0, walls = 0, debris = 0;
  const lay = (label: string, shape: Shape) => {
    if (!canvas.fits(shape)) return false;
    room.push({ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } });
    roomShapes.push(shape);
    pieces.push(shape);
    return true;
  };

  for (const slot of [...mask.cells].sort(compareCells)) {
    if (!onLattice(slot.x, phase.x) || !onLattice(slot.y, phase.y)) continue;
    if (draw(brief.seed, slot.x, slot.y, CHANNEL.slot) >= density) continue;
    const w = 3 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.width) * 2);
    const h = 3 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.height) * 2);
    if (!owns(slot.x, slot.y, w, h)) continue;
    // The doorway's side must open onto owned cells, two deep, or the room could be sealed.
    const beyond: Record<Side, boolean> = {
      north: owns(slot.x, slot.y - 2, w, 2), east: owns(slot.x + w, slot.y, 2, h),
      south: owns(slot.x, slot.y + h, w, 2), west: owns(slot.x - 2, slot.y, 2, h),
    };
    const open = SIDES.filter(side => beyond[side]);
    if (!open.length) continue;
    const door = open[Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.door) * open.length)]!;
    rooms++;
    room = []; roomShapes = [];
    const doorLength = door === 'north' || door === 'south' ? w : h;
    const doorAt = Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.doorAt) * (doorLength - 1));
    // The doorway's two spans, and the end span of a side it meets at a corner, so the gap stays two cells wide.
    const gaps = new Set([`${door}:${doorAt}`, `${door}:${doorAt + 1}`]);
    const [before, after] = door === 'north' || door === 'south' ? ['west', 'east'] : ['north', 'south'];
    const end = door === 'north' || door === 'west' ? 0 : (door === 'south' ? h : w) - 1;
    if (doorAt === 0) gaps.add(`${before}:${end}`);
    if (doorAt + 2 === doorLength) gaps.add(`${after}:${end}`);
    for (const [s, side] of SIDES.entries()) {
      const across = side === 'north' || side === 'south', length = across ? w : h;
      for (let i = 0; i < length; i++) {
        if (gaps.has(`${side}:${i}`)) continue;
        const cx = across ? slot.x + i : side === 'west' ? slot.x : slot.x + w - 1;
        const cy = across ? (side === 'north' ? slot.y : slot.y + h - 1) : slot.y + i;
        const label = `ruins-${side}-${cx}-${cy}`;
        if (draw(brief.seed, cx, cy, CHANNEL.span + s) >= decay) {
          const span = expectPlaced(RUIN_ROOM_SPAN.build({ side }, size));
          const local = (span.elements[0]!.template.parts[0] as { shape: Shape }).shape;
          if (local.kind !== 'rect') throw new Error('A ruin room span must be a rectangle.');
          // Keep the old arithmetic order in the absolute-shape record, including fractional cell sizes.
          const shape = rect(side === 'east' ? (cx + 1) * size - local.w : cx * size,
            side === 'south' ? (cy + 1) * size - local.h : cy * size, local.w, local.h);
          if (lay(`${label}-wall`, shape)) walls++;
        } else if (draw(brief.seed, cx, cy, CHANNEL.debris + s) < .5
          && lay(`${label}-debris`, slab(cx, cy, size, draw(brief.seed, cx, cy, CHANNEL.angle + s), draw(brief.seed, cx, cy, CHANNEL.size + s)))) debris++;
      }
    }
    // These legacy world-absolute records' template boxes are not their intent; their shapes are.
    // The room's box is not either, as a protected route may run through a fallen span.
    // Siting has already accepted every span, so a refusal is a broken placement invariant.
    if (room.length && !canvas.commit({ elements: room, areas: disjoint(roomShapes), extents: roomShapes }))
      throw new Error(`Ruins room at ${slot.x},${slot.y} failed its canvas commit.`);
  }

  const hinted = wallHints(brief, { kind: 'ruin-wall', thickness: WALL, avoid: [...protectedShapes, ...pieces] });
  commitHintWalls(canvas, hinted);
  const elements = [...canvas.elements];
  const loot = cellLoot(brief, createRegionMask(brief), [...pieces, ...hinted.shapes], CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { rooms, walls, debris, hintWalls: hinted.shapes.length });
}

/** Adapt a locally built slab to the legacy world-absolute element record. */
function slab(cx: number, cy: number, size: number, turn: number, length: number): Shape {
  const built = expectPlaced(FALLEN_SLAB.build({ turn, length }, size));
  const local = (built.elements[0]!.template.parts[0] as { shape: Shape }).shape;
  if (local.kind !== 'polygon') throw new Error('A fallen slab must be a polygon.');
  return polygon((cx + .5) * size, (cy + .5) * size, local.points);
}
