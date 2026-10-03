import { circle } from '../../../shared/shape.ts';
import { coverAround } from './cover.ts';
import { createRegionMask } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';

/** Proposed (54): hunters start at least one tile, 6 cells, from every exit. */
const SET_BACK = 6;

function cellsParameter(brief: RegionBrief, name: string): number | undefined {
  const value = brief.parameters?.[name];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    throw new RangeError(`Region ${brief.id}: departure ${name} must be a positive number of cells.`);
  return value;
}

/**
 * The `departure` region type (54): where contestants extract and hunters start. It has no
 * decomposer yet, and takes its region whole.
 *
 * Exits are spread first, farthest-first, so they sit as far apart as the region allows;
 * `exitSpacing` (cells) is only a floor. They may share one corridor (17 M13). Then every
 * hunter's spawn is spread over what lies at least `setBack` cells from every exit, so the
 * hunt begins as a pursuit. Each site is reachable from the first portal. A region that can't
 * hold them all sites fewer, and the report names the shortfall (51 stage 8). Cover and loot
 * fill around them as in `arrival`.
 */
export function buildDeparture(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const exitSpacing = cellsParameter(brief, 'exitSpacing') ?? 0, setBack = (cellsParameter(brief, 'setBack') ?? SET_BACK) * size;
  const mask = createRegionMask(brief);
  const root = portalStands(brief, mask).find(portal => portal.points.length)?.points[0];
  const anchor = root ? { anchor: root } : {};

  const exits = spreadPoints(mask, { count: brief.coreElements?.exit ?? 0, radius: clearance.contestant, seed: brief.seed,
    minimumSpacing: Math.max(clearance.contestant * 2, exitSpacing * size), ...anchor }).points;
  // A hunter's disc touching this ring's disc has its centre exactly `setBack` from the exit.
  // The ring never shrinks below a contestant, so no hunter stands on an exit.
  const ring = Math.max(setBack - clearance.hunter, clearance.contestant);
  const hunters = spreadPoints(mask, { count: brief.coreElements?.['hunter-spawn'] ?? 0, radius: clearance.hunter, seed: brief.seed,
    reservations: exits.map(exit => circle(exit.x, exit.y, ring)), ...anchor }).points;

  const coreElements = [
    ...exits.map(point => ({ kind: 'exit' as const, ...point })),
    ...hunters.map(point => ({ kind: 'hunter-spawn' as const, ...point })),
  ];
  const { elements, loot } = coverAround(brief, [
    ...exits.map(point => ({ ...point, radius: clearance.contestant })),
    ...hunters.map(point => ({ ...point, radius: clearance.hunter })),
  ], root);

  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements, loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: coreElements.length } };
}
