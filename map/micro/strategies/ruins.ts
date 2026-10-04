import { polygon, rect } from '../../../shared/shape.ts';
import { buildOpen } from './open.ts';
import { cellLoot, draw, fraction, protectedRoutes } from './scatter.ts';
import { createRegionMask, shapesOverlap } from '../geometry.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

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
 * So the region keeps the portal promise whenever its shape does. A region smaller than
 * `MIN_CELLS`, or with no owned 3 × 3 box for a room, goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear
 * of every piece. Ruins site no core elements; any the brief lists are left for the report.
 */
export function buildRuins(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Ruins', 'density', DEFAULT_DENSITY);
  const decay = fraction(brief, 'Ruins', 'decay', DEFAULT_DECAY);
  const mask = createRegionMask(brief), size = brief.cellSize;
  if (brief.cells.length < MIN_CELLS || !mask.rectangles(3, 3).length) return buildOpen(brief);

  const protectedShapes = protectedRoutes(brief, mask, 'Ruins');
  const phase = { x: Math.floor(draw(brief.seed, 0, 0, CHANNEL.phase) * PERIOD), y: Math.floor(draw(brief.seed, 1, 0, CHANNEL.phase) * PERIOD) };
  const onLattice = (value: number, offset: number) => ((value - offset) % PERIOD + PERIOD) % PERIOD === 0;
  const owns = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (!mask.has(i, j)) return false;
    return true;
  };

  const elements: RegionElement[] = [], pieces: Shape[] = [];
  let rooms = 0, walls = 0, debris = 0;
  const lay = (label: string, shape: Shape) => {
    if (!mask.contains(shape) || protectedShapes.some(keep => shapesOverlap(shape, keep))) return false;
    elements.push({ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } });
    pieces.push(shape);
    return true;
  };

  for (const slot of [...mask.cells].sort((a, b) => a.y - b.y || a.x - b.x)) {
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
          const t = WALL * size;
          const shape = across ? rect(cx * size, side === 'north' ? cy * size : (cy + 1) * size - t, size, t)
            : rect(side === 'west' ? cx * size : (cx + 1) * size - t, cy * size, t, size);
          if (lay(`${label}-wall`, shape)) walls++;
        } else if (draw(brief.seed, cx, cy, CHANNEL.debris + s) < .5
          && lay(`${label}-debris`, slab(cx, cy, size, draw(brief.seed, cx, cy, CHANNEL.angle + s), draw(brief.seed, cx, cy, CHANNEL.size + s)))) debris++;
      }
    }
  }

  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: 0, rooms, walls, debris } };
}

/** A fallen span: a convex slab inside its own cell, at a turn and length drawn from 0 to 1. */
function slab(cx: number, cy: number, size: number, turn: number, length: number): Shape {
  const angle = turn * Math.PI, long = size * (.55 + length * .25), wide = size * WALL * 1.2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Engines may differ in trig's last bit, so the corners are rounded to a thousandth: the
  // browser Lab and the server then build the same slab.
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({
    x: round(u! * long / 2 * cos - v! * wide / 2 * sin), y: round(u! * long / 2 * sin + v! * wide / 2 * cos) }));
  return polygon((cx + .5) * size, (cy + .5) * size, points);
}
