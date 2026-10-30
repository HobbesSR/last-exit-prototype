/** Source-bound #698 audit only. Same exact endpoint/sweep semantics as 51.10. */
import { composeRegions } from '../../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../../map/micro/adapter.ts';
import { buildPortalGraph } from '../../map/navigation.ts';
import { entry, freePaths, mapFreeSpace } from '../../shared/free-space.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import { regionAt } from '../../shared/navigation/portal-graph.ts';
import { bodyRadius, sweptClear } from '../../shared/movement.ts';

export function measurePocketRoutes(map, pairsByBody) {
  const built = composeRegions(map.results), { origin } = builtMapFrame(built);
  const graph = buildPortalGraph(built, origin), nav = navigationMap(builtMapCollision(built), true);
  return { roles: [['contestant', 'contestant'], ['hunter', 'gladiator']].map(([body, role]) => {
    const clearance = navigationClearance(role), radius = bodyRadius({ role });
    const space = mapFreeSpace(nav, `park-pocket audit ${body}`, [{ x: 0, y: 0, w: nav.width, h: nav.height }], clearance);
    const labels = new Int32Array(space.triangles.length / 3).fill(-1);
    for (let root = 0; root < labels.length; root++) {
      if (labels[root] !== -1) continue;
      const pending = [root]; labels[root] = root;
      while (pending.length) {
        const t = pending.pop();
        for (let k = 0; k < 3; k++) {
          const twin = space.twins[t * 3 + k]; if (twin < 0) continue;
          const to = Math.floor(twin / 3); if (labels[to] !== -1) continue;
          labels[to] = root; pending.push(to);
        }
      }
    }
    const pairs = pairsByBody[body] ?? [], output = new Array(pairs.length), groups = new Map();
    pairs.forEach((p, i) => {
      const key = `${p.from.x},${p.from.y}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ p, i });
    });
    for (const group of groups.values()) {
      const from = group[0].p.from;
      const paths = freePaths(space, from, group.map(({ p }) => p.to), clearance + 1);
      group.forEach(({ p, i }, j) => {
        const path = paths[j], distance = Math.hypot(p.to.x - from.x, p.to.y - from.y);
        let status = 'complete';
        if (!sweptClear(nav, from, from, radius) || !sweptClear(nav, p.to, p.to, radius)) status = 'invalid-endpoint';
        else if (!path) {
          const a = entry(space, from, clearance + 1), b = entry(space, p.to, clearance + 1);
          status = a && b && labels[a.triangle] !== labels[b.triangle] ? 'unreachable' : 'search-miss';
        } else for (let k = 0; k < path.points.length - 1; k++) {
          const r = Math.min(clearance, k === 0 && path.leads[0] ? radius : clearance,
            k === path.points.length - 2 && path.leads[1] ? radius : clearance);
          if (!sweptClear(nav, path.points[k], path.points[k + 1], r)) { status = 'sweep-defect'; break; }
        }
        output[i] = { ...p, stratum: p.stratum ?? 'focused', fromRegion: regionAt(graph, from), toRegion: regionAt(graph, p.to),
          status, distance, length: status === 'complete' ? path.length : null,
          ratio: status === 'complete' && distance ? path.length / distance : null, points: path?.points ?? [] };
      });
    }
    return { body, samples: output };
  }) };
}

export function pocketPairs(element, size, origin) {
  const point = (x, y) => ({ x: element.x + x * size + origin.x, y: element.y + y * size + origin.y });
  return [4, 7, 10].flatMap(y => [3, 7, 11].map(x => ({ category: 'pocket-target', from: point(-1.5, y), to: point(x, y) })))
    .concat([4, 7, 10].map(y => ({ category: 'external-crossing', from: point(-1.5, y), to: point(15.5, y) })))
    .concat([4, 7, 10].map(y => ({ category: 'mouth-control', from: point(15.5, 7), to: point(7, y) })));
}
