import { rect } from '../../../shared/shape.ts';
import { buildOpen } from './open.ts';
import { cellLoot, draw, protectedRoutes } from './scatter.ts';
import { createRegionMask, shapesOverlap } from '../geometry.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { BuiltRegion, RegionBrief, RegionMask } from '../types.ts';

/** The catalogue's proposed shape need (54): a contained rectangle at least this many cells a side. */
const MIN_SIDE = 6;
/** A pillar stands on a 2 × 2 block of cells, as mapgen's `pillar-hall` blocks did. */
const BLOCK = 2;
/** How far a pillar stands inside its block, in cells, as `hut`'s house does inside its box. */
const INSET = 0.25;
/**
 * Cells from one pillar's block to the next. The least leaves an aisle of 2½ cells between
 * pillars, a doorway (52) with room for the sampled route search (20).
 */
const MIN_SPACING = 4;
const DEFAULT_SPACING = 5;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { axis: 1, loot: 2 };

type Box = { x: number; y: number; w: number; h: number };

/**
 * The `hall` region type (54): a staggered lattice of pillars that breaks sightlines without
 * blocking a walk. It has no decomposer.
 *
 * It takes the region's largest contained rectangle at least `MIN_SIDE` cells a side, and
 * keeps the rest of the region clear. Pillar blocks lie `spacing` cells apart on the
 * rectangle, centred in it. Each row is offset from the last by about half a period along
 * one axis, drawn from the seed, so a sightline down that axis meets a pillar within a few
 * rows. The other axis keeps clean lanes, the walk the design leaves open. Only one axis is
 * staggered: staggering both pinches pillar corners together.
 *
 * Portal approaches and one hunter route between portals are protected in the empty shape
 * first, and a pillar that would touch them is left out, as `rubble` and `ruins` do. So the
 * region keeps the portal promise whenever its shape does. With `roofed`, the rectangle has a
 * roof, which hides what's under it as a building's does. A region with no such rectangle
 * goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear
 * of every pillar. A hall sites no core elements; any the brief lists are left for the report.
 */
export function buildHall(brief: RegionBrief): BuiltRegion {
  const spacing = brief.parameters?.spacing ?? DEFAULT_SPACING;
  if (typeof spacing !== 'number' || !Number.isInteger(spacing) || spacing < MIN_SPACING)
    throw new RangeError(`Hall spacing must be a whole number of cells, at least ${MIN_SPACING}.`);
  const roofed = brief.parameters?.roofed ?? false;
  if (typeof roofed !== 'boolean') throw new TypeError('Hall roofed must be true or false.');

  const mask = createRegionMask(brief), size = brief.cellSize;
  const box = largestRectangle(mask, MIN_SIDE);
  if (!box) return buildOpen(brief);

  const protectedShapes = protectedRoutes(brief, mask, 'Hall');
  const staggerRows = draw(brief.seed, 0, 0, CHANNEL.axis) < 0.5;
  // A stride that divides the period repeats after two rows and leaves a lane open the whole way.
  const stride = spacing % 2 === 0 ? spacing / 2 + 1 : (spacing - 1) / 2;
  // Lines of blocks run along the staggered axis (u) and step across the other (v).
  const [us, ul, vs, vl] = staggerRows ? [box.x, box.w, box.y, box.h] : [box.y, box.h, box.x, box.w];
  // Centre the lattice across: the slack past the last whole line is split between the two ends.
  const ou = us + Math.floor((ul - BLOCK) % spacing / 2), ov = vs + Math.floor((vl - BLOCK) % spacing / 2);
  const span = (BLOCK - 2 * INSET) * size;

  const parts: ElementTemplate['parts'] = [], pillars: Shape[] = [];
  for (let v = ov, line = 0; v + BLOCK <= vs + vl; v += spacing, line++) {
    // Each line starts a period early, so its first block can stand at the near end.
    for (let u = ou + (line * stride) % spacing - spacing; u + BLOCK <= us + ul; u += spacing) {
      if (u < us) continue;
      const [bx, by] = staggerRows ? [u, v] : [v, u];
      const shape = rect((bx + INSET) * size, (by + INSET) * size, span, span);
      if (!mask.contains(shape) || protectedShapes.some(keep => shapesOverlap(shape, keep))) continue;
      pillars.push(shape);
      parts.push({ part: 'obstacle', shape: rect((bx - box.x + INSET) * size, (by - box.y + INSET) * size, span, span), kind: 'building' });
    }
  }

  const elements = parts.length || roofed ? [{ label: 'hall', x: box.x * size, y: box.y * size,
    template: { w: box.w * size, h: box.h * size, ...(roofed ? { encloses: true } : {}), parts } }] : [];
  const loot = cellLoot(brief, mask, pillars, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: roofed ? 1 : 0, obstacles: pillars.length, gates: 0,
      loot: loot.length, coreElements: 0, pillars: pillars.length } };
}

/**
 * The owned rectangle of largest area, in cells, with both sides at least `least`, or nothing.
 * Ties go to the first in row order, so the choice doesn't depend on the brief's cell order.
 */
export function largestRectangle(mask: Pick<RegionMask, 'cellSize' | 'bounds' | 'has'>, least: number): Box | undefined {
  const size = mask.cellSize;
  const x0 = Math.round(mask.bounds.x / size), y0 = Math.round(mask.bounds.y / size);
  const w = Math.round(mask.bounds.w / size), h = Math.round(mask.bounds.h / size);
  const heights = new Array<number>(w).fill(0);
  let best: Box | undefined;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) heights[x] = mask.has(x0 + x, y0 + y) ? heights[x]! + 1 : 0;
    // Every maximal rectangle ending on this row is the widest run at one bar's height.
    const stack: number[] = [];
    for (let x = 0; x <= w; x++) {
      const height = x < w ? heights[x]! : 0;
      while (stack.length && heights[stack[stack.length - 1]!]! >= height) {
        const top = heights[stack.pop()!]!, left = stack.length ? stack[stack.length - 1]! + 1 : 0, width = x - left;
        if (top >= least && width >= least && (!best || top * width > best.w * best.h))
          best = { x: x0 + left, y: y0 + y - top + 1, w: width, h: top };
      }
      stack.push(x);
    }
  }
  return best;
}
