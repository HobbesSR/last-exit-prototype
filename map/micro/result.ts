import type { BuiltRegion, CoreElementSite, LootSite, RegionBrief, RegionElement } from './types.ts';

/**
 * A strategy's result, with the manifest counted from what landed (51 stage 6): structures
 * are the enclosing elements, obstacles and gates their parts. `extra` adds the strategy's
 * own counts after the shared ones. Counting here, never by hand, keeps a manifest from
 * drifting from the geometry it describes.
 */
export function builtRegion(brief: RegionBrief, elements: RegionElement[], loot: LootSite[], coreElements: CoreElementSite[] = [],
  extra: Record<string, number> = {}): BuiltRegion {
  const parts = elements.flatMap(element => element.template.parts);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements, loot,
    manifest: { cells: brief.cells.length, structures: elements.filter(element => element.template.encloses).length,
      obstacles: parts.filter(part => part.part === 'obstacle').length, gates: parts.filter(part => part.part === 'gate').length,
      loot: loot.length, coreElements: coreElements.length, ...extra } };
}
