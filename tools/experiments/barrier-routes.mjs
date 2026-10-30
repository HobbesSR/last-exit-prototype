/** Fixed-endpoint geometry measurements for static barrier experiments. */
import { composeRegions } from '../../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../../map/micro/adapter.ts';
import { buildPortalGraph } from '../../map/navigation.ts';
import { freePaths, mapFreeSpace } from '../../shared/free-space.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import { regionAt } from '../../shared/navigation/portal-graph.ts';
import { bodyRadius } from '../../shared/movement.ts';
import { classifyNavigationRoute } from '../../map/tools/navigation-structure.ts';

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Measure caller-supplied world-space endpoints against the whole playable map for both bodies.
 * The endpoints are used exactly as supplied; invalid endpoints are reported, never snapped.
 * Unlike #688's within-region sample, every query searches the whole-map free-space mesh.
 */
export function measureFixedRoutes(map, pairsByBody) {
  const built = composeRegions(map.results);
  const collision = builtMapCollision(built);
  const { origin } = builtMapFrame(built);
  const graph = buildPortalGraph(built, origin);
  const nav = navigationMap(collision, true);
  const roles = [];
  for (const [body, role] of [['contestant', 'contestant'], ['hunter', 'gladiator']]) {
    const clearance = navigationClearance(role), radius = bodyRadius({ role });
    const space = mapFreeSpace(nav, `barrier-routes whole map ${body}`, [{ x: 0, y: 0, w: nav.width, h: nav.height }], clearance);
    const samples = [];
    for (const pair of pairsByBody[body] ?? []) {
      const { category, from, to } = pair;
      const direct = distance(from, to);
      if (direct === 0) continue;
      const path = freePaths(space, from, [to], clearance + 1)[0] ?? null;
      const status = classifyNavigationRoute(nav, space, from, to, path, clearance, radius);
      const worldFrom = { x: from.x, y: from.y }, worldTo = { x: to.x, y: to.y };
      samples.push({ category, stratum: pair.stratum ?? 'focused', from: worldFrom, to: worldTo,
        fromRegion: regionAt(graph, from), toRegion: regionAt(graph, to), status, distance: direct,
        length: status === 'complete' ? path.length : null,
        ratio: status === 'complete' ? path.length / direct : null,
        points: status === 'invalid-endpoint' ? [] : path?.points.map(p => ({ x: p.x, y: p.y })) ?? [] });
    }
    roles.push({ body, samples });
  }
  return { roles };
}
