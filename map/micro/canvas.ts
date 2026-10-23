import { circle, rect } from '../../shared/shape.ts';
import type { Shape } from '../../shared/shape.ts';
import { createAddressedArea } from './addressed.ts';
import { createAccessMask, createFillMask, elementShapes, shapesOverlap } from './geometry.ts';
import type { RegionBrief, RegionElement } from './types.ts';

export interface CanvasAssembly {
  /** Already positioned elements, in output order. No IDs are allocated here. */
  elements: readonly RegionElement[];
  /** World-space intent; defaults to each element's template box. Must be nonempty. */
  areas?: readonly Shape[];
  /** Standing room or swept routes to preserve, contained in the access mask. */
  access?: readonly Shape[];
}

/**
 * Production region-2 placement. Siting, RNG, route search and result manifests remain
 * the strategy's responsibility. An assembly's elements and addressed areas commit together.
 * Intent is not occupancy: overlapping parts inside one assembly are allowed.
 */
export function createBuilderCanvas(brief: RegionBrief, protectedShapes: readonly Shape[] = []) {
  const fill = createFillMask(brief), access = createAccessMask(brief);
  const addressed = createAddressedArea(fill), elements: RegionElement[] = [];
  const protections = structuredClone([...protectedShapes]), blockers: Shape[] = [];
  return {
    fill, access, addressed,
    get elements(): readonly RegionElement[] { return elements; },
    commit(assembly: CanvasAssembly): boolean {
      // Own the input before validation so later caller edits cannot invalidate a commit.
      const next = structuredClone(assembly);
      if (!next.elements.length) return false;
      const areas = next.areas ?? next.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));
      const geometry = next.elements.flatMap(e => elementShapes(e, true));
      const footprints = next.elements.flatMap(e => e.template.encloses ? [rect(e.x, e.y, e.template.w, e.template.h)] : []);
      const reserves = next.elements.flatMap(e => e.template.parts.flatMap(p => p.part === 'reserve'
        ? [rect(e.x + p.x, e.y + p.y, p.w, p.h)] : []));
      const spots = next.elements.flatMap(e => e.template.parts.flatMap(p => p.part === 'spot'
        ? [circle(e.x + p.x, e.y + p.y, 1)] : []));
      const roofs = next.elements.flatMap(e => (e.template.roofs ?? []).flatMap(roof => {
        const size = roof.cellSize ?? 40;
        return roof.cells.map(c => rect(e.x + (roof.origin?.x ?? 0) + c.x * size,
          e.y + (roof.origin?.y ?? 0) + c.y * size, size, size));
      }));
      const clear = next.access ?? [];
      if (!areas.length || [...areas, ...geometry, ...footprints, ...reserves, ...spots, ...roofs].some(s => !fill.contains(s)
        || protections.some(p => shapesOverlap(s, p)))) return false;
      if (geometry.some(s => blockers.some(p => shapesOverlap(s, p)))) return false;
      if (reserves.some(s => blockers.some(p => shapesOverlap(s, p)))) return false;
      if (clear.some(s => !access.contains(s) || [...blockers, ...geometry].some(p => shapesOverlap(s, p)))) return false;
      if (!addressed.markAll(areas)) return false;
      elements.push(...next.elements);
      blockers.push(...geometry);
      protections.push(...clear, ...reserves);
      return true;
    },
    /** Empty intent may include a protected route: it adds no blocking geometry. */
    markEmpty(areas: readonly Shape[]): boolean {
      return areas.every(s => fill.contains(s)) && addressed.markAll(areas);
    },
  };
}
