import { bounds, circle, rect } from '../../shared/shape.ts';
import type { Shape } from '../../shared/shape.ts';
import { createAddressedArea } from './addressed.ts';
import { createAccessMask, createFillMask, elementShapes, shapesOverlap, shapesShareArea } from './geometry.ts';
import type { RegionBrief, RegionElement } from './types.ts';

export interface CanvasAssembly {
  /** Already positioned elements, in output order. No IDs are allocated here. */
  elements: readonly RegionElement[];
  /** World-space intent; defaults to each element's template box. Must be nonempty. */
  areas?: readonly Shape[];
  /** Standing room or swept routes to preserve, contained in the access mask. */
  access?: readonly Shape[];
  /**
   * What later pieces keep their clearance from (`spaced`); defaults to each element's template
   * box. World-absolute records, whose template box spans the region, pass their shapes.
   */
  extents?: readonly Shape[];
}

const elementReserves = (e: RegionElement): Shape[] => e.template.parts.flatMap(p => p.part === 'reserve'
  ? [rect(e.x + p.x, e.y + p.y, p.w, p.h)] : []);

/** Routing occupancy excludes roofs, enclosed floor space and standing spots. */
export function assemblyBlockers(assembly: CanvasAssembly): Shape[] {
  return assembly.elements.flatMap(e => [...elementShapes(e, true), ...elementReserves(e)]);
}

/** Full physical/content footprint, including non-colliding roofs and enclosed interiors. */
export function assemblyFootprints(assembly: CanvasAssembly): Shape[] {
  return assembly.elements.flatMap(e => [
    ...elementShapes(e, true),
    ...(e.template.encloses ? [rect(e.x, e.y, e.template.w, e.template.h)] : []),
    ...elementReserves(e),
    ...e.template.parts.flatMap(p => p.part === 'spot' ? [circle(e.x + p.x, e.y + p.y, 1)] : []),
    ...(e.template.roofs ?? []).flatMap(roof => {
      const size = roof.cellSize ?? 40;
      return roof.cells.map(c => rect(e.x + (roof.origin?.x ?? 0) + c.x * size,
        e.y + (roof.origin?.y ?? 0) + c.y * size, size, size));
    }),
  ]);
}

/**
 * Production region-2 placement. Siting, RNG, route search and result manifests remain
 * the strategy's responsibility. An assembly's elements and addressed areas commit together.
 * Intent is not occupancy: overlapping parts inside one assembly are allowed.
 *
 * Siting asks the canvas rather than keeping its own ledger: `fits` and `spaced` read what is
 * committed, so a candidate a strategy accepts with them commits unless its parts collide.
 */
export function createBuilderCanvas(brief: RegionBrief, protectedShapes: readonly Shape[] = []) {
  const fill = createFillMask(brief), access = createAccessMask(brief);
  const addressed = createAddressedArea(fill), elements: RegionElement[] = [];
  const protections = structuredClone([...protectedShapes]), blockers: Shape[] = [], extents: Shape[] = [];
  return {
    fill, access, addressed,
    get elements(): readonly RegionElement[] { return elements; },
    /** Whether `shape` may stand: inside the fill and off every protection, committed access and reserves included. */
    fits(shape: Shape): boolean {
      return fill.contains(shape) && !protections.some(p => shapesOverlap(shape, p));
    },
    /**
     * Whether `shape`'s bounds keep `clearance` from every committed extent. Clearance between
     * pieces is a relation between them, not intent, so this never reads the addressed record (#404).
     */
    spaced(shape: Shape, clearance = 0): boolean {
      const box = bounds(shape), grown = rect(box.x - clearance, box.y - clearance, box.w + 2 * clearance, box.h + 2 * clearance);
      return !extents.some(e => shapesOverlap(grown, e));
    },
    commit(assembly: CanvasAssembly): boolean {
      // Own the input before validation so later caller edits cannot invalidate a commit.
      const next = structuredClone(assembly);
      if (!next.elements.length) return false;
      const areas = next.areas ?? next.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));
      const geometry = next.elements.flatMap(e => elementShapes(e, true));
      const footprints = next.elements.flatMap(e => e.template.encloses ? [rect(e.x, e.y, e.template.w, e.template.h)] : []);
      const reserves = next.elements.flatMap(elementReserves);
      const spots = next.elements.flatMap(e => e.template.parts.flatMap(p => p.part === 'spot'
        ? [circle(e.x + p.x, e.y + p.y, 1)] : []));
      const roofs = next.elements.flatMap(e => (e.template.roofs ?? []).flatMap(roof => {
        const size = roof.cellSize ?? 40;
        return roof.cells.map(c => rect(e.x + (roof.origin?.x ?? 0) + c.x * size,
          e.y + (roof.origin?.y ?? 0) + c.y * size, size, size));
      }));
      const clear = next.access ?? [];
      if (!areas.length || [...areas, ...geometry, ...footprints, ...reserves, ...spots, ...roofs].some(s => !fill.contains(s))) return false;
      // Only what stands is kept off protections. Roofs only conceal sight (15), so routes may pass
      // beneath them, and intent is not occupancy, so it may include a route, as `markEmpty`'s may.
      if ([...geometry, ...reserves, ...spots].some(s => protections.some(p => shapesOverlap(s, p)))) return false;
      // Separate assemblies may stand flush, as a pipe ends on its machine's surface; only shared
      // area collides (#489). What a protection keeps clear, standing room included, stays clear of contact.
      if (geometry.some(s => blockers.some(p => shapesShareArea(s, p)))) return false;
      if (reserves.some(s => blockers.some(p => shapesOverlap(s, p)))) return false;
      if (clear.some(s => !access.contains(s) || [...blockers, ...geometry].some(p => shapesOverlap(s, p)))) return false;
      if (!addressed.markAll(areas)) return false;
      elements.push(...next.elements);
      blockers.push(...geometry);
      extents.push(...next.extents ?? next.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h)));
      protections.push(...clear, ...reserves);
      return true;
    },
    /** Empty intent may include a protected route: it adds no blocking geometry. */
    markEmpty(areas: readonly Shape[]): boolean {
      return areas.every(s => fill.contains(s)) && addressed.markAll(areas);
    },
  };
}

/**
 * Several assemblies as one, in order. Defaults are made explicit, so the result addresses,
 * spaces and protects exactly what the parts would one by one.
 */
export function mergeAssemblies(assemblies: readonly CanvasAssembly[]): CanvasAssembly {
  const boxes = (a: CanvasAssembly) => a.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));
  return {
    elements: assemblies.flatMap(a => a.elements),
    areas: assemblies.flatMap(a => a.areas ?? boxes(a)),
    access: assemblies.flatMap(a => a.access ?? []),
    extents: assemblies.flatMap(a => a.extents ?? boxes(a)),
  };
}

/**
 * Commit assemblies in order with as few commits as stand together: the whole batch is tried as
 * one assembly, and a refused batch is split in half, down to single assemblies, which are passed
 * over when refused. On a prospective-parcels coordinator (20.10) each commit is one cord search,
 * so a batch that stands costs one search rather than one per piece. Cord existence only shrinks
 * as blockers are added, so this keeps what committing one at a time would, up to the search's
 * own non-monotonicity. Returns whether each assembly was committed.
 */
export function commitEach(canvas: Pick<SitingCanvas, 'commit'>, assemblies: readonly CanvasAssembly[]): boolean[] {
  const kept = assemblies.map(() => false);
  // `refused`: this run is known to fail as a whole, because its accepted left half
  // leaves exactly the state in which the whole was refused.
  const run = (lo: number, hi: number, refused = false): void => {
    if (hi <= lo) return;
    if (!refused && canvas.commit(mergeAssemblies(assemblies.slice(lo, hi)))) { kept.fill(true, lo, hi); return; }
    if (hi - lo === 1) return;
    const mid = (lo + hi) >> 1;
    run(lo, mid);
    run(mid, hi, kept.slice(lo, mid).every(Boolean));
  };
  run(0, assemblies.length);
  return kept;
}

export type BuilderCanvas = ReturnType<typeof createBuilderCanvas>;
/**
 * What siting asks of a canvas. A prospective-parcels coordinator (20.10) offers the same,
 * and refuses a commit that would leave no hunter cord to every portal stand.
 */
export type SitingCanvas = Pick<BuilderCanvas, 'fill' | 'access' | 'elements' | 'fits' | 'spaced' | 'commit'>;
