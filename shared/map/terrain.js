import { BLOCK_SIZE } from './world.js';
import { blockRoute } from './graph.js';
const gap = 300, wall = 40;

export function buildTerrain(context) {
  const { map, lookup, ports, edgeKey, rect } = context;
  // Every shared boundary is emitted once. Open connections have offset doorways; closed ones
  // become continuous terrain walls. Thus no horizontal highway survives across the map.
  for (const n of map.nodes) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = lookup.get((n.col + dx) + ',' + (n.row + dy));
    if (q && n.id > q.id) continue;
    const vertical = !!dx, x = n.x + dx * BLOCK_SIZE / 2, y = n.y + dy * BLOCK_SIZE / 2;
    const port = q && ports.get(edgeKey(n, q));
    const start = vertical ? n.y - 480 : n.x - 500, end = vertical ? n.y + 480 : n.x + 500;
    const opening = port && (vertical ? port.y : port.x);
    for (const [a, b] of port ? [[start, opening - gap / 2], [opening + gap / 2, end]] : [[start, end]]) {
      if (b <= a) continue;
      if (vertical) rect(x - wall / 2, a, wall, b - a, 'ruin-wall');
      else rect(a, y - wall / 2, b - a, wall, 'ruin-wall');
    }
  }
  // A few narrow shortcuts connect nearby blocks for contestants while larger hunters must detour.
  for (const n of map.nodes) {
    if (map.gaps.length >= 3) break;
    const q = lookup.get((n.col + 1) + ',' + n.row);
    if (!q || n.neighbors.includes(q.id) || blockRoute(map, n, q).length > 6 || n.x < 5000) continue;
    const x = n.x + 500, y = n.y;
    const index = map.obstacles.findIndex(o => o.kind === 'ruin-wall' && o.x === x - 20 && o.y < y - 100 && o.y + o.h > y + 100);
    if (index < 0) continue;
    const original = map.obstacles.splice(index, 1)[0];
    rect(original.x, original.y, original.w, y - 16 - original.y, 'ruin-wall');
    rect(original.x, y + 16, original.w, original.y + original.h - y - 16, 'ruin-wall');
    map.gaps.push({ x, y });
  }
}
