import { coverAround, coverNear } from './cover.ts';
import { createRegionMask, findRegionRoute } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';

/** Clear ground around a hunter transit station, measured in cells. */
const STANDING = 2;
const COVER_REACH = 2;

/** A transit region sites the warp promised by its set piece class. */
export function buildTransit(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const standing = brief.parameters?.standing ?? STANDING;
  if (typeof standing !== 'number' || !Number.isFinite(standing) || standing <= 0)
    throw new RangeError(`Region ${brief.id}: transit standing must be a positive number of cells.`);
  const mask = createRegionMask(brief), radius = clearance.hunter, count = brief.coreElements?.warp ?? 0;
  const root = portalStands(brief, mask).find(portal => portal.points.length)?.points[0];

  let warps = spreadPoints(mask, { count, radius, seed: brief.seed }).points;
  if (root && warps.some(point => !findRegionRoute(mask, [], root, point, radius)))
    warps = spreadPoints(mask, { count, radius, seed: brief.seed, anchor: root }).points;

  const sites = warps.map(point => ({ ...point, radius: Math.max(standing * size, radius), reach: radius }));
  let cover = coverAround(brief, sites, root);
  for (const site of sites) cover = coverNear(brief, cover, site, COVER_REACH * size, root);
  const { elements, loot } = cover;
  const coreElements = warps.map(point => ({ kind: 'warp' as const, ...point }));

  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements, loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: coreElements.length } };
}
