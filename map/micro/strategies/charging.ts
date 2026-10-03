import { coverAround, coverNear } from './cover.ts';
import { createRegionMask, findRegionRoute } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';

/**
 * Proposed (54): cells around the charger kept clear of cover and loot. The live game
 * charges within 70 units, 1.75 cells at 40 units a cell (14).
 */
const STANDING = 2;
/** Proposed (54): some cover stands within this many cells of the standing room, a doorway's width. */
const COVER_REACH = 2;

/**
 * The `charging` region type (54): the power-cell charging station (F-03). It has no
 * decomposer yet, and takes its region whole.
 *
 * The charger stands as near the region's middle as a contestant fits and can walk to
 * from the first portal. Cover and loot keep off the ground within `standing` cells of it,
 * so contestants can stand round it. Then some cover stands within `COVER_REACH` cells of
 * that ground, if the region has room, so the five-second wait (14) is a choice rather than
 * a death. A region with no room for the charger sites none, and the report names the
 * shortfall (51 stage 8).
 */
export function buildCharging(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const standing = brief.parameters?.standing ?? STANDING;
  if (typeof standing !== 'number' || !Number.isFinite(standing) || standing <= 0)
    throw new RangeError(`Region ${brief.id}: charging standing must be a positive number of cells.`);
  const mask = createRegionMask(brief), radius = clearance.contestant, count = brief.coreElements?.charger ?? 0;
  const root = portalStands(brief, mask).find(portal => portal.points.length)?.points[0];

  // The middle first; if a contestant can't walk there from the first portal, the nearest place it can.
  let chargers = spreadPoints(mask, { count, radius, seed: brief.seed }).points;
  if (root && chargers.some(point => !findRegionRoute(mask, [], root, point, radius)))
    chargers = spreadPoints(mask, { count, radius, seed: brief.seed, anchor: root }).points;

  const sites = chargers.map(point => ({ ...point, radius: Math.max(standing * size, radius), reach: radius }));
  let cover = coverAround(brief, sites, root);
  for (const site of sites) cover = coverNear(brief, cover, site, COVER_REACH * size, root);
  const { elements, loot } = cover;
  const coreElements = chargers.map(point => ({ kind: 'charger' as const, ...point }));

  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements, loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: coreElements.length } };
}
