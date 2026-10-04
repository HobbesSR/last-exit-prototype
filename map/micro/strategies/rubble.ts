import { CELL_SCALE } from '../../kernel/scale.ts';
import { rect } from '../../../shared/shape.ts';
import { buildOpen } from './open.ts';
import { cellLoot, draw, fraction, protectedRoutes } from './scatter.ts';
import { createRegionMask, shapesOverlap } from '../geometry.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

const DEFAULT_DENSITY = 0.85;
const DEFAULT_SQUEEZE_SHARE = 0.8;

/**
 * Rubble has no children (54). Two-cell-spaced debris leaves selected 1.5-cell
 * gaps. Full portal approaches and one hunter route from the first portal to
 * each other portal are protected before any debris is placed.
 */
export function buildRubble(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Rubble', 'density', DEFAULT_DENSITY);
  const squeezeShare = fraction(brief, 'Rubble', 'squeezeShare', DEFAULT_SQUEEZE_SHARE);
  const mask = createRegionMask(brief);
  const spanX = mask.bounds.w / brief.cellSize, spanY = mask.bounds.h / brief.cellSize;
  // The catalogue's shape need is proposed; open is the last resort (17 M24).
  if (brief.cells.length < 12 || Math.min(spanX, spanY) < 3) return buildOpen(brief);

  const protectedShapes = protectedRoutes(brief, mask, 'Rubble');
  const elements: RegionElement[] = [];
  const debris: Shape[] = [];
  let squeezeDebris = 0;
  // A half-cell square at every other cell leaves exactly 1.5 cells between
  // neighbors. The narrow variant leaves 1.9 cells, above hunter clearance.
  for (const cell of mask.cells) {
    if ((cell.x & 1) || (cell.y & 1) || draw(brief.seed, cell.x, cell.y, 1) >= density) continue;
    const squeeze = draw(brief.seed, cell.x, cell.y, 2) < squeezeShare;
    const width = (squeeze ? 2 - CELL_SCALE.squeeze : 0.1) * brief.cellSize;
    const shape = rect((cell.x + .5) * brief.cellSize - width / 2,
      (cell.y + .5) * brief.cellSize - width / 2, width, width);
    if (!mask.contains(shape) || protectedShapes.some(keep => shapesOverlap(shape, keep))) continue;
    const label = `rubble-${cell.x}-${cell.y}`;
    elements.push({ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } });
    debris.push(shape);
    if (squeeze) squeezeDebris++;
  }

  const loot = cellLoot(brief, mask, debris, 3);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: 0, squeezeDebris } };
}
