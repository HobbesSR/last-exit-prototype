import { capsule, createAccessMask, findRegionRoute } from '../geometry.ts';
import { hunterClearance, portalStands } from '../portals.ts';
import { portalApproaches } from '../strategies/scatter.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { RegionBrief } from '../types.ts';

/*
 * The retired frozen-route reservation (#787). No strategy reads it: every builder now places
 * through a live cord (`liveCord`, 20.10). It is kept only as the fixed control of the #663
 * depot comparison (`buildDepotExperiment`) and for the tools that measure against it.
 */

/**
 * The shapes no piece may touch: `portalApproaches`, and hunter routes connecting the portals in the empty shape. By default, each route
 * starts at the first portal. `'nearby'` instead joins the nearest portal outside the
 * connected set, comparing squared Euclidean stand distances, not routed path lengths,
 * and breaking ties by source then destination order in `portalStands`.
 * One portal carries no route obligation, so it
 * protects nothing. `type` names the region type in what it throws.
 */
export function frozenRoutes(brief: RegionBrief, type: string, mode: 'root' | 'nearby' = 'root'): Shape[] {
  const mask = createAccessMask(brief), radius = hunterClearance(brief.cellSize), stands = portalStands(brief);
  const kept = portalApproaches(brief, type);
  if (!kept.length) return kept;
  if (mode === 'root') {
    const root = stands[0]!.points[0]!;
    for (const { portal, points } of stands.slice(1)) {
      const route = findRegionRoute(mask, [], root, points[0]!, radius);
      if (!route) throw new Error(`${type} region ${brief.id} cannot join portal ${portal.id} in its empty shape.`);
      for (let i = 1; i < route.length; i++) kept.push(...capsule(route[i - 1]!, route[i]!, radius));
    }
    return kept;
  }
  const connected = new Set([0]);
  while (connected.size < stands.length) {
    let from = -1, to = -1, shortest = Infinity;
    for (let a = 0; a < stands.length; a++) if (connected.has(a)) {
      const p = stands[a]!.points[0]!;
      for (let b = 0; b < stands.length; b++) if (!connected.has(b)) {
        const q = stands[b]!.points[0]!, dx = p.x - q.x, dy = p.y - q.y;
        const distance = dx * dx + dy * dy;
        if (distance < shortest) { from = a; to = b; shortest = distance; }
      }
    }
    const { portal, points } = stands[to]!;
    const route = findRegionRoute(mask, [], stands[from]!.points[0]!, points[0]!, radius);
    if (!route) throw new Error(`${type} region ${brief.id} cannot join portal ${portal.id} in its empty shape.`);
    for (let i = 1; i < route.length; i++) kept.push(...capsule(route[i - 1]!, route[i]!, radius));
    connected.add(to);
  }
  return kept;
}
