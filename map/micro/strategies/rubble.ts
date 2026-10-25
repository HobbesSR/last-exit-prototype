import { rect } from '../../../shared/shape.ts';
import { RUBBLE_DEBRIS } from '../placeables/rubble-debris.ts';
import { expectPlaced } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createFillMask, createRegionMask } from '../geometry.ts';
import { commitHintWalls, wallHints } from '../hint-walls.ts';
import { createBuilderCanvas } from '../canvas.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

const DEFAULT_DENSITY = 0.85;
const DEFAULT_SQUEEZE_SHARE = 0.8;

/**
 * Rubble has no children (54). Two-cell-spaced debris leaves selected 1.5-cell
 * gaps. Full portal approaches and one hunter route from the first portal to
 * each other portal are protected before any debris is placed. Plain walls then
 * stand along every hinted run where no debris or route is (`wallHints`).
 */
export function buildRubble(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Rubble', 'density', DEFAULT_DENSITY);
  const squeezeShare = fraction(brief, 'Rubble', 'squeezeShare', DEFAULT_SQUEEZE_SHARE);
  const mask = createFillMask(brief);
  const ownedMask = createRegionMask(brief);
  const spanX = ownedMask.bounds.w / brief.cellSize, spanY = ownedMask.bounds.h / brief.cellSize;
  // The catalogue's shape need is proposed; open is the last resort (17 M24).
  if (!mask.cells.length || brief.cells.length < 12 || Math.min(spanX, spanY) < 3) return unfilledRegion(brief, 3);

  const protectedShapes = protectedRoutes(brief, 'Rubble');
  const canvas = createBuilderCanvas(brief, protectedShapes);
  const debris: Shape[] = [];
  let squeezeDebris = 0;
  // A half-cell square at every other cell leaves exactly 1.5 cells between
  // neighbors. The narrow variant leaves 1.9 cells, above hunter clearance.
  for (const cell of mask.cells) {
    if ((cell.x & 1) || (cell.y & 1) || draw(brief.seed, cell.x, cell.y, 1) >= density) continue;
    const squeeze = draw(brief.seed, cell.x, cell.y, 2) < squeezeShare;
    const built = expectPlaced(RUBBLE_DEBRIS.build({ squeeze }, brief.cellSize));
    const local = (built.elements[0]!.template.parts[0] as { shape: Shape }).shape;
    if (local.kind !== 'rect') throw new Error('Rubble debris must be a rectangle.');
    // Preserve the centre-first arithmetic of the legacy absolute-shape record.
    const shape = rect((cell.x + .5) * brief.cellSize - local.w / 2,
      (cell.y + .5) * brief.cellSize - local.h / 2, local.w, local.h);
    if (!canvas.fits(shape)) continue;
    const label = `rubble-${cell.x}-${cell.y}`;
    // A legacy world-absolute record: its template box is not its intent, so the debris is.
    // Siting has already accepted it, so a refusal is a broken placement invariant.
    if (!canvas.commit({ elements: [{ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } }], areas: [shape], extents: [shape] }))
      throw new Error(`Rubble placement ${label} failed its canvas commit.`);
    debris.push(shape);
    if (squeeze) squeezeDebris++;
  }

  const walls = wallHints(brief, { kind: 'ruin-wall', avoid: [...protectedShapes, ...debris] });
  commitHintWalls(canvas, walls);
  const elements = [...canvas.elements];
  const loot = cellLoot(brief, createRegionMask(brief), [...debris, ...walls.shapes], 3);
  return builtRegion(brief, elements, loot, [], { squeezeDebris, hintWalls: walls.shapes.length });
}
