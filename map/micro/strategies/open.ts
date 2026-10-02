import type { BuiltRegion, RegionBrief } from '../types.ts';

/**
 * The `open` region type (54): the fill, and every decomposer's last resort (17 M24).
 * For now it builds nothing, so the region is pure open cells (17 M25). Every cell and
 * every inside segment stays passable, and it places no core elements and no loot. A brief
 * that lists core elements gets none, and the shortfall is the report's to name (51 stage 8).
 */
export function buildOpen(brief: RegionBrief): BuiltRegion {
  return { version: 'region-2', brief: structuredClone(brief), elements: [], coreElements: [], loot: [],
    manifest: { cells: brief.cells.length, structures: 0, obstacles: 0, gates: 0, loot: 0, coreElements: 0 } };
}
