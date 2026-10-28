import { rect } from '../../../shared/shape.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { MARKET_STALL } from '../placeables/market-stall.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { draw } from '../random.ts';
import { builtRegion } from '../result.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { cellLoot, protectedRoutes, unfilledRegion } from './scatter.ts';

const AISLE = CELL_SCALE.doorway;
const DEPTH = 2;
const CHANNEL = { cross: 1, loot: 2 };

/** Market rows cover the whole mask, leaving two-cell lanes and periodic wider cross-lanes. */
export function buildMarket(brief: RegionBrief): BuiltRegion {
  const spacing = brief.parameters?.spacing ?? 6;
  if (typeof spacing !== 'number' || !Number.isInteger(spacing) || spacing < 4)
    throw new RangeError('Market spacing must be a whole number of cells, at least 4.');
  const roofed = brief.parameters?.roofed ?? true;
  if (typeof roofed !== 'boolean') throw new TypeError('Market roofed must be true or false.');
  const canvas = createBuilderCanvas(brief, protectedRoutes(brief, 'Market', 'nearby'));
  if (!canvas.fill.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  const size = brief.cellSize, bounds = createRegionMask(brief).bounds;
  const alongX = bounds.w >= bounds.h, length = Math.min(4, spacing - AISLE);
  const [u0, v0, width, height] = alongX
    ? [bounds.x / size, bounds.y / size, bounds.w / size, bounds.h / size]
    : [bounds.y / size, bounds.x / size, bounds.h / size, bounds.w / size];
  // Center complete slots inside the bypass band, rather than wasting the outer
  // row on candidates that cannot possibly retain their ring at the boundary.
  const columns = Math.max(0, Math.floor((width - 2 * AISLE - length) / spacing) + 1);
  const rows = Math.max(0, Math.floor((height - 2 * AISLE - DEPTH) / (DEPTH + AISLE)) + 1);
  const startU = u0 + Math.floor((width - (columns - 1) * spacing - length) / 2);
  const startV = v0 + Math.floor((height - (rows - 1) * (DEPTH + AISLE) - DEPTH) / 2);
  const cross = Math.floor(draw(brief.seed, 0, 0, CHANNEL.cross) * 4);
  let stalls = 0;
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    // The same skipped column across all rows makes a cross-lane, rather than isolated holes.
    if (columns >= 4 && (col + cross) % 4 === 3) continue;
    const u = startU + col * spacing, v = startV + row * (DEPTH + AISLE);
    const [x, y, w, h] = alongX ? [u, v, length, DEPTH] : [v, u, DEPTH, length];
    const footprint = rect(x * size, y * size, w * size, h * size);
    // The full bypass ring prevents a stall closing a neck or trapping a side pocket,
    // including one-portal markets where a portal tree alone protects no local circulation.
    if (!canvas.access.contains(rect((x - AISLE) * size, (y - AISLE) * size,
      (w + 2 * AISLE) * size, (h + 2 * AISLE) * size))
      || !canvas.fits(footprint) || !canvas.spaced(footprint, AISLE * size)) continue;
    const stall = expectPlaced(MARKET_STALL.build({ length, alongX, flipped: row % 2 === 1, roofed }, size));
    if (!canvas.commit({ elements: placedElements(stall, `market-stall-${++stalls}`, x, y, size) }))
      throw new Error('Market stall failed its canvas commit.');
  }
  if (!stalls) return unfilledRegion(brief, CHANNEL.loot);
  const elements = [...canvas.elements];
  const loot = cellLoot(brief, createRegionMask(brief), elements.flatMap(e => elementShapes(e, true)), CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { stalls, awnings: roofed ? stalls : 0 });
}
