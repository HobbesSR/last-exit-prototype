import { compareCells } from '../kernel/cell.ts';
import { cellComponents } from './components.ts';
import { withClearMargins } from '../kernel/margins.ts';
import type { MarginRegion } from '../kernel/margins.ts';
import type { Cell, Portal, RegionBrief } from './types.ts';
import type { Run } from '../kernel/run.ts';

/**
 * The SDK's tool limits (20). They bound the work one call can do; they aren't contract
 * rules or match dimensions, so macro never reads them. They are sized for macro's regions
 * (17 M7): a layout region may be a whole map's open ground, hundreds of cells across with
 * hundreds of portals, and a map composes hundreds of regions.
 */
export const LIMITS = Object.freeze({
  /** One region's cells. */
  regionCells: 65_536,
  /** One region's extent, in cells per axis. */
  regionSpan: 512,
  /** One region's portals, or its ports. */
  portals: 4_096,
  /** One portal's or port's run, in segments. */
  run: 512,
  /** The regions one composition joins. */
  mapRegions: 4_096,
});

/**
 * Check one region's cells against the limits and return them in row order: whole
 * addresses, no duplicates, the bounded span, and one four-connected area.
 */
export function checkedRegionCells(cells: readonly Cell[]): Cell[] {
  if (!Array.isArray(cells) || !cells.length || cells.length > LIMITS.regionCells) throw new Error(`A region needs 1 to ${LIMITS.regionCells} cells.`);
  // Translation does not increase region work. Require exact integer addresses
  // with room for the bounded run/margin offsets used by the SDK instead of
  // imposing a map-size ceiling measured from the origin.
  const exactAddress = (n: number) => Number.isSafeInteger(n)
    && Number.isSafeInteger(n - LIMITS.run - 2) && Number.isSafeInteger(n + LIMITS.run + 2);
  if (cells.some(c => !c || !exactAddress(c.x) || !exactAddress(c.y))) throw new Error('Cell addresses must be safe integers with representable run and margin offsets.');
  const sorted = cells.map(c => ({ x: c.x, y: c.y })).sort(compareCells), keys = new Set(sorted.map(c => `${c.x},${c.y}`));
  if (keys.size !== sorted.length) throw new Error('Duplicate region cell.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of sorted) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  if (maxX - minX >= LIMITS.regionSpan || maxY - minY >= LIMITS.regionSpan) throw new Error(`A region may span at most ${LIMITS.regionSpan} cells per axis.`);
  if (cellComponents(sorted).length !== 1) throw new Error('Region cells must form one connected area.');
  return sorted;
}

/** Check a portal list against the limits: bounded, unique ids, each a whole run within `LIMITS.run`. */
export function checkedPortals(portals: readonly Portal[]): readonly Portal[] {
  if (!Array.isArray(portals) || portals.length > LIMITS.portals) throw new Error('Portals must be a bounded list.');
  const ids = new Set<string>();
  for (const portal of portals) {
    if (!portal || typeof portal.id !== 'string' || !portal.id || ids.has(portal.id)) throw new Error('Portals need unique ids.');
    ids.add(portal.id);
    if (!boundedRun(portal)) throw new Error(`Portal ${portal.id} is not a run.`);
  }
  return portals;
}

const boundedRun = ({ axis, x, y, length }: Run): boolean =>
  (axis === 'h' || axis === 'v') && [x, y, length].every(Number.isInteger) && length >= 1 && length <= LIMITS.run;

/**
 * A region's clear margins (20.6), with its portals and internal runs held to the limits
 * first, so a malformed or oversized run is refused before any margin is derived.
 */
export function checkedMargins<R extends MarginRegion>(region: R): R & Required<Pick<RegionBrief, 'fillCells' | 'clearCells'>> {
  checkedPortals(region.portals);
  const internal = region.internalGuaranteed ?? [];
  if (!Array.isArray(internal) || internal.length > LIMITS.portals || !internal.every(run => run && boundedRun(run)))
    throw new Error('Internal guaranteed runs must be a bounded list of runs.');
  return withClearMargins(region);
}
