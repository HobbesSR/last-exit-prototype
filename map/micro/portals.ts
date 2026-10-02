import { microMetrics } from './metrics.ts';
import { LIMITS } from './limits.ts';
import { capsule, createRegionMask, findRegionRoute, shapesOverlap, travelClear, validShape } from './geometry.ts';
import type { Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { Cell, Portal, RegionMask, RegionRoute } from './types.ts';

/** A brief's region: its cells at `cellSize` world units, with the kernel's body scale. */
export interface PortalRegion { cells: Cell[]; cellSize: number; portals: Portal[] }
export interface PortalReachInput extends PortalRegion { blockers: Shape[] }
export interface PortalReachResult {
  valid: boolean;
  errors: string[];
  routes: Array<RegionRoute & { from: string; to: string }>;
}
/** Where a hunter stands at each part of one portal, in order along it. Empty when no hunter fits. */
export interface PortalStands { portal: Portal; inward: Vec2; points: Vec2[] }

/** A brief's bodies are the kernel's body scale, which is the SDK's `cell` profile. */
export const hunterClearance = (cellSize: number): number => microMetrics({ cellSize, bodyProfile: 'cell' }).clearance.hunter;

/**
 * Resolve each portal's inward side and the hunter stands that cover it. A stand touches
 * the portal from inside, and stands sit at most half a cell apart from one end of the
 * portal to the other, so together their bodies cover every part of it. Throws when a
 * portal isn't a straight run on the region's perimeter, with the region on one side.
 */
export function portalStands(region: PortalRegion, mask: RegionMask = createRegionMask(region)): PortalStands[] {
  if (!Array.isArray(region.portals) || region.portals.length > LIMITS.portals) throw new Error('Portals must be a bounded list.');
  const size = region.cellSize, radius = hunterClearance(size), ids = new Set<string>();
  return region.portals.map(portal => {
    if (!portal || typeof portal.id !== 'string' || !portal.id || ids.has(portal.id)) throw new Error('Portals need unique ids.');
    ids.add(portal.id);
    const { axis, x, y, length } = portal;
    if (axis !== 'h' && axis !== 'v' || ![x, y, length].every(Number.isInteger) || length < 1 || length > LIMITS.run) throw new Error(`Portal ${portal.id} is not a run.`);
    // The cells on each side of segment i: `before` is above or left of the line, `after` below or right.
    const sides = Array.from({ length }, (_, i) => axis === 'h'
      ? [mask.has(x + i, y - 1), mask.has(x + i, y)] : [mask.has(x - 1, y + i), mask.has(x, y + i)]);
    const after = sides.every(([b, a]) => !b && a), before = sides.every(([b, a]) => b && !a);
    if (!after && !before) throw new Error(`Portal ${portal.id} must lie on the region's perimeter, with the region on one side.`);
    const sign = after ? 1 : -1, inward = axis === 'h' ? { x: 0, y: sign } : { x: sign, y: 0 };
    const span = length * size, inset = radius + 1, free = span - 2 * radius;
    if (free < 0) return { portal, inward, points: [] };
    const count = Math.ceil(free / (size / 2)) + 1, line = (axis === 'h' ? y : x) * size, start = (axis === 'h' ? x : y) * size;
    const points = Array.from({ length: count }, (_, i) => {
      const along = start + radius + (count > 1 ? free * i / (count - 1) : free / 2), across = line + sign * inset;
      return axis === 'h' ? { x: along, y: across } : { x: across, y: along };
    });
    return { portal, inward, points };
  });
}

/**
 * Whether a hunter standing at `point`, inward of a portal by construction, can actually
 * cross the boundary there. The mirrored outside endpoint is deliberately unconstrained by
 * the mask, like `access.ts`'s `crossingClear`: a boundary crossing reaches beyond owned
 * cells. This is what tells a thin wall sitting right on the boundary from an obstacle
 * elsewhere in the interior, which the standing-room check alone cannot.
 */
function crossingClear(inward: Vec2, point: Vec2, radius: number, blockers: readonly Shape[]): boolean {
  const outside: Vec2 = { x: point.x - inward.x * 2 * (radius + 1), y: point.y - inward.y * 2 * (radius + 1) };
  return capsule(outside, point, radius).every(part => !blockers.some(blocker => shapesOverlap(part, blocker)));
}

/**
 * Elective (51 principle 9): check a region's promise from its final collision geometry.
 * Every part of every portal must be reachable by a hunter from every other portal, from
 * within the region, assuming nothing outside it. One portal carries no requirement.
 * The route search is sampled: a found route is a real one, but a miss doesn't prove
 * that none exists (20, "Geometry and reachability"). It reports; it never repairs.
 */
export function validatePortalReach(input: PortalReachInput): PortalReachResult {
  const errors: string[] = [], routes: PortalReachResult['routes'] = [];
  try {
    if (!Array.isArray(input.blockers) || input.blockers.some(shape => !validShape(shape))) throw new Error('Blockers must be valid convex collision shapes.');
    const mask = createRegionMask(input), stands = portalStands(input, mask), radius = hunterClearance(input.cellSize);
    if (stands.length < 2) return { valid: true, errors, routes };
    const route = (from: Vec2, to: Vec2) => findRegionRoute(mask, input.blockers, from, to, radius);
    const reached: Array<{ id: string; at: Vec2 }> = [];
    for (const { portal, inward, points } of stands) {
      if (!points.length) { errors.push(`Portal ${portal.id} is too short for a hunter.`); continue; }
      const blocked = points.filter(p => !travelClear(mask, input.blockers, p, p, radius) || !crossingClear(inward, p, radius, input.blockers));
      if (blocked.length) { errors.push(`Portal ${portal.id} is obstructed at ${blocked.length} of ${points.length} hunter stands.`); continue; }
      // Along one portal a straight sweep usually suffices; a route covers a portal bent by an obstacle.
      let joined = true;
      for (let i = 1; i < points.length && joined; i++) joined = travelClear(mask, input.blockers, points[i - 1]!, points[i]!, radius) || !!route(points[i - 1]!, points[i]!);
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
  return { valid: errors.length === 0, errors, routes };
}
