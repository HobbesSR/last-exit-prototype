import { elementShapes } from './geometry.ts';
import { validatePortalReach } from './portals.ts';
import type { BuiltMap, RegionElement } from './types.ts';

/** A region whose geometry doesn't keep its portal promise, with what the check found. */
export interface BrokenPromise { region: string; errors: string[] }

/**
 * A diagnostic for a built map (51 stage 8): run the elective portal check
 * (`validatePortalReach`) on every region's own geometry, and name each region whose
 * builder broke its promise. It checks each region against its own brief, never the whole
 * map, because reachability is inferred (51 principle 8). So a sealed pocket inside a
 * region is the builder's business, and is never named.
 *
 * It locates defects; it never rejects or repairs a map. The route search is sampled, so a
 * region it names may still be passable, and one it passes isn't proven so.
 */
export function diagnoseBuiltMap(map: BuiltMap<RegionElement>): BrokenPromise[] {
  return map.regions.flatMap(({ brief, elements }) => {
    const { errors } = validatePortalReach({ ...brief, blockers: elements.flatMap(element => elementShapes(element)) });
    return errors.length ? [{ region: brief.id, errors }] : [];
  });
}
