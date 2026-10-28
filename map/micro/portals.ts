import { microMetrics } from './metrics.ts';
import { freePaths, triangulateFreeSpace, type FreeSpace } from '../../shared/free-space.ts';
import { bounds, rect, transform } from '../../shared/shape.ts';
import { CLIP_SCALE } from '../../shared/shape-construction.ts';
import { checkedPortals } from './limits.ts';
import { createAccessMask, createRegionMask, findRegionRoute, travelClear, validShape } from './geometry.ts';
import type { Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { Cell, Portal, RegionRoute } from './types.ts';
import type { Run } from '../kernel/run.ts';

/** A brief's region: its cells at `cellSize` world units, with the kernel's body scale. */
export interface PortalRegion { cells: Cell[]; cellSize: number; portals: Portal[]; fillCells?: Cell[]; clearCells?: Cell[]; internalGuaranteed?: Run[] }
export interface PortalReachInput extends PortalRegion { blockers: Shape[] }
export interface PortalReachOptions { search?: 'grid' | 'thorough' }
export interface PortalJoin {
  from: Vec2;
  to: Vec2;
  /** A miss is no witness found, never proof of impossibility. */
  search: 'direct' | 'grid' | 'mesh' | 'none';
  points: Vec2[] | null;
}
export interface PortalReachResult {
  valid: boolean;
  errors: string[];
  routes: Array<RegionRoute & { from: string; to: string }>;
  /** Includes adjacent stands along long portals as well as inter-portal joins. */
  joins: PortalJoin[];
  meshBuilds: number;
}
/** Where a hunter stands at each part of one portal, in order along it. Empty when no hunter fits. */
export interface PortalStands { portal: Portal; inward: Vec2; points: Vec2[] }

/** A brief's bodies are the kernel's body scale, which is the SDK's `cell` profile. */
export const hunterClearance = (cellSize: number): number => microMetrics({ cellSize, bodyProfile: 'cell' }).clearance.hunter;

/**
 * Resolve each portal's inward side and the hunter stands that cover it. A stand is centred
 * on the portal's line, its body straddling the seam into the clear margin on both sides
 * (20.6), and stands sit at most half a cell apart from one end of the portal to the other,
 * so together their bodies cover every part of it. Throws when a portal isn't a straight
 * run on the region's perimeter, with the region on one side. Sides are read from original
 * ownership, never from a fill or access mask.
 */
export function portalStands(region: PortalRegion): PortalStands[] {
  const mask = createRegionMask(region);
  const size = region.cellSize, radius = hunterClearance(size);
  return checkedPortals(region.portals).map(portal => {
    const { axis, x, y, length } = portal;
    // The cells on each side of segment i: `before` is above or left of the line, `after` below or right.
    const sides = Array.from({ length }, (_, i) => axis === 'h'
      ? [mask.has(x + i, y - 1), mask.has(x + i, y)] : [mask.has(x - 1, y + i), mask.has(x, y + i)]);
    const after = sides.every(([b, a]) => !b && a), before = sides.every(([b, a]) => b && !a);
    if (!after && !before) throw new Error(`Portal ${portal.id} must lie on the region's perimeter, with the region on one side.`);
    const sign = after ? 1 : -1, inward = axis === 'h' ? { x: 0, y: sign } : { x: sign, y: 0 };
    const span = length * size, free = span - 2 * radius;
    if (free < 0) return { portal, inward, points: [] };
    const count = Math.ceil(free / (size / 2)) + 1, line = (axis === 'h' ? y : x) * size, start = (axis === 'h' ? x : y) * size;
    const points = Array.from({ length: count }, (_, i) => {
      const along = start + radius + (count > 1 ? free * i / (count - 1) : free / 2);
      return axis === 'h' ? { x: along, y: line } : { x: line, y: along };
    });
    return { portal, inward, points };
  });
}

/**
 * Elective (51 principle 9): check a region's promise from its final collision geometry.
 * Every part of every portal must be reachable by a hunter from every other portal, from
 * within original ownership and its explicit known-clear context. Fewer than two portals
 * carry no reachability requirement: no stand clearance or joins are checked, and a portal
 * too short for a hunter is not reported (20.1).
 * Input checks still apply, including collision shapes, bounded runs and portal placement.
 * Their automatic margin is `validateFillConstraints`'s.
 * Default search is sampled. Optional thorough search retries misses on a shared
 * free-space mesh, with every endpoint lead and segment swept against final geometry.
 * A miss in either mode doesn't prove impossibility (20.2). It reports; it never repairs.
 */
export function validatePortalReach(input: PortalReachInput, options: PortalReachOptions = {}): PortalReachResult {
  const errors: string[] = [], routes: PortalReachResult['routes'] = [], joins: PortalJoin[] = [];
  let mesh: FreeSpace | undefined, meshBuilds = 0;
  try {
    if (options.search !== undefined && options.search !== 'grid' && options.search !== 'thorough') throw new Error('Unknown portal search mode.');
    if (!Array.isArray(input.blockers) || input.blockers.some(shape => !validShape(shape))) throw new Error('Blockers must be valid convex collision shapes.');
    const mask = createAccessMask(input), stands = portalStands(input), radius = hunterClearance(input.cellSize);
    if (stands.length < 2) return { valid: true, errors, routes, joins, meshBuilds };
    const route = (from: Vec2, to: Vec2): Vec2[] | null => {
      const direct = travelClear(mask, input.blockers, from, to, radius);
      let points = direct ? [from, to] : findRegionRoute(mask, input.blockers, from, to, radius);
      let search: PortalJoin['search'] = points ? (direct ? 'direct' : 'grid') : 'none';
      if (!points && options.search === 'thorough') {
        if (!mesh) {
          // Overlap cell edges by construction-grid slivers, as shared openGround does.
          // Erosion keeps its shared defaults; final sweeps enforce the exact access mask.
          const pad = 2 / CLIP_SCALE, size = mask.cellSize;
          // Normalize before clipping: translating a bounded region must not
          // consume Clipper's integer coordinate range (20.2, #330).
          const domain = mask.cells.map(c => rect(c.x * size - mask.bounds.x - pad, c.y * size - mask.bounds.y - pad, size + 2 * pad, size + 2 * pad));
          const box = mask.bounds;
          const nearby = input.blockers.filter(s => {
            const b = bounds(s);
            return b.x <= box.x + box.w + pad && b.x + b.w >= box.x - pad && b.y <= box.y + box.h + pad && b.y + b.h >= box.y - pad;
          });
          mesh = triangulateFreeSpace(domain, domain, nearby.map(s => transform(s, -box.x, -box.y)), radius);
          meshBuilds++;
        }
        // One cell is a bounded attachment search, including corner displacement from
        // conservative erosion. It grants no clearance: every lead is swept below.
        const local = (p: Vec2): Vec2 => ({ x: p.x - mask.bounds.x, y: p.y - mask.bounds.y });
        const candidate = freePaths(mesh, local(from), [local(to)], input.cellSize)[0];
        const world = candidate?.points.map((p, i, all) => i === 0 ? from : i === all.length - 1 ? to : { x: p.x + mask.bounds.x, y: p.y + mask.bounds.y });
        if (world && world.every((p, i, all) => travelClear(mask, input.blockers, i ? all[i - 1]! : p, p, radius))) {
          points = world; search = 'mesh';
        }
      }
      joins.push({ from, to, search, points });
      return points;
    };
    const reached: Array<{ id: string; at: Vec2 }> = [];
    for (const { portal, points } of stands) {
      if (!points.length) { errors.push(`Portal ${portal.id} is too short for a hunter.`); continue; }
      // A stand straddles the seam, so a clear body there is the crossing: a wall on the
      // boundary overlaps it, and the access mask holds no space outside the margins.
      const blocked = points.filter(p => !travelClear(mask, input.blockers, p, p, radius));
      if (blocked.length) { errors.push(`Portal ${portal.id} is obstructed at ${blocked.length} of ${points.length} hunter stands.`); continue; }
      // Along one portal a straight sweep usually suffices; a route covers a portal bent by an obstacle.
      let joined = true;
      for (let i = 1; i < points.length && joined; i++) joined = !!route(points[i - 1]!, points[i]!);
      if (!joined) { errors.push(`Portal ${portal.id} is divided: part of it is unreachable from the rest.`); continue; }
      reached.push({ id: portal.id, at: points[0]! });
    }
    const [first, ...rest] = reached;
    for (const other of first ? rest : []) {
      const points = route(first.at, other.at);
      if (points) routes.push({ role: 'hunter', radius, points, from: first.id, to: other.id });
      else errors.push(`Portal ${other.id} is unreachable from portal ${first.id}.`);
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors, routes, joins, meshBuilds };
}
