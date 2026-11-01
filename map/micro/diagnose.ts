import { elementShapes } from './geometry.ts';
import { validateFillConstraints } from './margins.ts';
import { validatePortalReach } from './portals.ts';
import type { BuiltMap, BuiltRegion, RegionElement } from './types.ts';

/** A region whose geometry doesn't keep its portal promise, with what the check found. */
export interface BrokenPromise { region: string; errors: string[] }

/**
 * What a builder's promise check finds in one region's own geometry (`diagnoseBuiltMap`),
 * empty when it keeps its promise. It reads the region alone, so a replay of one region
 * type's briefs (53) can run it without a map.
 *
 * The search is thorough (20.10): a grid miss is retried on a free-space mesh with every
 * segment swept, the proof cord adopters (hut, compound, park) keep while they place. A
 * grid-only check named routes between trees as broken that a hunter can walk (#750).
 */
export function diagnoseRegion({ brief, elements }: Pick<BuiltRegion, 'brief' | 'elements'>): string[] {
  // Doors don't block a hunter, but they are geometry, so they must stay in the fill.
  const blockers = elements.flatMap(element => elementShapes(element));
  const placed = elements.flatMap(element => elementShapes(element, true));
  return [...validateFillConstraints(brief, placed), ...validatePortalReach({ ...brief, blockers }, { search: 'thorough' }).errors];
}

/**
 * A diagnostic for a built map (51 stage 8): run the elective portal check
 * (`validatePortalReach`) on every region's own geometry, and name each region whose
 * builder broke its promise. It checks each region against its own brief, never the whole
 * map, because reachability is inferred (51 principle 8). So a sealed pocket inside a
 * region is the builder's business, and is never named.
 *
 * It locates defects; it never rejects or repairs a map. A route it finds is swept, but a
 * miss is not proof: a region it names may still be passable.
 */
export function diagnoseBuiltMap(map: BuiltMap<RegionElement>): BrokenPromise[] {
  return map.regions.flatMap((region) => {
    const errors = diagnoseRegion(region);
    return errors.length ? [{ region: region.brief.id, errors }] : [];
  });
}
