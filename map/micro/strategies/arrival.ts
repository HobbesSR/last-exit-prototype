import { coverAround } from './cover.ts';
import { createRegionMask } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';

/**
 * The one arrival region owns every contestant spawn (17 M20, 54). For now its
 * decomposer selects the whole region as the single spawn child. The point placement
 * is the reusable SDK's farthest-first spread; cover and loot use the cover strategy
 * after the points claim their ground. Dropping cover cannot break a portal route.
 */
export function buildArrival(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize;
  const metrics = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const radius = metrics.clearance.contestant;
  const spacing = brief.parameters?.spacing;
  if (spacing !== undefined && (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing <= 0))
    throw new RangeError(`Region ${brief.id}: arrival spacing must be a positive number of cells.`);

  const mask = createRegionMask(brief);
  const root = portalStands(brief, mask).find(portal => portal.points.length)?.points[0];
  const requested = brief.coreElements?.spawn ?? 0;
  const points = spreadPoints(mask, { count: requested, radius, seed: brief.seed,
    minimumSpacing: Math.max(radius * 2, (spacing ?? 0) * size), ...(root ? { anchor: root } : {}) }).points;
  const coreElements = points.map(point => ({ kind: 'spawn' as const, ...point }));
  const { elements, loot } = coverAround(brief, points.map(point => ({ ...point, radius })), root);

  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements, loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: coreElements.length } };
}
