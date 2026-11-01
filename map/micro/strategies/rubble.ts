import { rect } from '../../../shared/shape.ts';
import { RUBBLE_DEBRIS } from '../placeables/rubble-debris.ts';
import { expectPlaced } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, portalApproaches } from './scatter.ts';
import { draw } from '../random.ts';
import { createFillMask, createRegionMask } from '../geometry.ts';
import { commitHintWalls, wallHints } from '../hint-walls.ts';
import { createProspectiveParcels } from '../prospective-parcels.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

const DEFAULT_DENSITY = 0.85;
const DEFAULT_SQUEEZE_SHARE = 0.8;

/**
 * Rubble has no children (54). Two-cell-spaced debris leaves selected 1.5-cell
 * gaps. Portal approaches stay clear. Nothing else is reserved between portals:
 * each piece commits only if a hunter cord still joins every portal stand, so
 * debris bends the way through rather than leaving a fixed route bare (20.10,
 * #759). Plain walls then stand along every hinted run where no debris or
 * approach is (`wallHints`), each wall passed over if the cord refuses it.
 */
export function buildRubble(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Rubble', 'density', DEFAULT_DENSITY);
  const squeezeShare = fraction(brief, 'Rubble', 'squeezeShare', DEFAULT_SQUEEZE_SHARE);
  const mask = createFillMask(brief);
  const ownedMask = createRegionMask(brief);
  const spanX = ownedMask.bounds.w / brief.cellSize, spanY = ownedMask.bounds.h / brief.cellSize;
  // The catalogue's shape need is proposed; open is the last resort (17 M24).
  if (!mask.cells.length || brief.cells.length < 12 || Math.min(spanX, spanY) < 3) return unfilledRegion(brief, 3);

  // Portal approaches are the fixed anchors; the coordinator keeps a live cord witness to
  // every stand and refuses a commit that would leave none (20.10).
  const approaches = portalApproaches(brief, 'Rubble');
  const parcels = createProspectiveParcels(brief, { fixedAccess: approaches });
  if (!parcels.ok) throw new Error(`Rubble region ${brief.id} cannot join its portals in its empty shape (${parcels.reason}).`);
  const canvas = parcels.coordinator;
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
    // Siting has accepted it, so a refusal means it would leave a portal without a cord: it is
    // passed over, and per-cell draws keep the rest unchanged.
    if (!canvas.commit({ elements: [{ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } }], areas: [shape], extents: [shape] })) continue;
    debris.push(shape);
    if (squeeze) squeezeDebris++;
  }

  const walls = commitHintWalls(canvas, wallHints(brief, { kind: 'ruin-wall', avoid: [...approaches, ...debris] }), { passOver: true });
  const elements = [...canvas.elements];
  const loot = cellLoot(brief, createRegionMask(brief), [...debris, ...walls.shapes], 3);
  return builtRegion(brief, elements, loot, [], { squeezeDebris, hintWalls: walls.shapes.length });
}
