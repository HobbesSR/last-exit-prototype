/** Fixed-endpoint geometry measurements for static barrier experiments. */
import { composeRegions } from '../../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../../map/micro/adapter.ts';
import { buildPortalGraph } from '../../map/navigation.ts';
import { entry, freePaths, mapFreeSpace } from '../../shared/free-space.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import { regionAt } from '../../shared/navigation/portal-graph.ts';
import { bodyRadius, sweptClear } from '../../shared/movement.ts';

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function componentLabels(space) {
  const labels = new Int32Array(space.triangles.length / 3).fill(-1);
  for (let root = 0; root < labels.length; root++) {
    if (labels[root] !== -1) continue;
    labels[root] = root;
    const pending = [root];
    while (pending.length) {
      const triangle = pending.pop();
      for (let k = 0; k < 3; k++) {
        const twin = space.twins[triangle * 3 + k];
        if (twin < 0) continue;
        const next = Math.floor(twin / 3);
        if (labels[next] !== -1) continue;
        labels[next] = root;
        pending.push(next);
      }
    }
  }
  return labels;
}

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
    let labels;
    const samples = [];
    for (const pair of pairsByBody[body] ?? []) {
      const { category, from, to } = pair;
      const direct = distance(from, to);
      if (direct === 0) continue;
      let status = 'complete', path = null;
      if (!sweptClear(nav, from, from, radius) || !sweptClear(nav, to, to, radius)) status = 'invalid-endpoint';
      else {
        path = freePaths(space, from, [to], clearance + 1)[0] ?? null;
        if (!path) {
          const a = entry(space, from, clearance + 1), b = entry(space, to, clearance + 1);
          if (!labels) labels = componentLabels(space);
          status = a && b && labels[a.triangle] !== labels[b.triangle] ? 'unreachable' : 'search-miss';
        } else {
          for (let k = 0; k < path.points.length - 1; k++) {
            const segmentRadius = Math.min(clearance,
              k === 0 && path.leads[0] ? radius : clearance,
              k === path.points.length - 2 && path.leads[1] ? radius : clearance);
            if (!sweptClear(nav, path.points[k], path.points[k + 1], segmentRadius)) {
              status = 'sweep-defect';
              break;
            }
          }
        }
      }
      const worldFrom = { x: from.x, y: from.y }, worldTo = { x: to.x, y: to.y };
      samples.push({ category, stratum: 'fixed', from: worldFrom, to: worldTo,
        fromRegion: regionAt(graph, from), toRegion: regionAt(graph, to), status, distance: direct,
        length: status === 'complete' ? path.length : null,
        ratio: status === 'complete' ? path.length / direct : null,
        points: path?.points.map(p => ({ x: p.x, y: p.y })) ?? [] });
    }
    roles.push({ body, samples });
  }
  return { roles };
}
