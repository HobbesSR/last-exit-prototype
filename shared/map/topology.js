import { insideMap } from '../movement.js';
import { WORLD_WIDTH, WORLD_HEIGHT, BLOCK_SIZE } from './world.js';
import { blockRoute, invalidateGraph } from './graph.js';

export function buildTopology(context) {
  const { map, random, range } = context;
  for (let col = 0; col < WORLD_WIDTH / BLOCK_SIZE; col++) for (let row = 0; row < WORLD_HEIGHT / BLOCK_SIZE; row++) {
    const x = (col + 0.5) * BLOCK_SIZE, y = (row + 0.5) * BLOCK_SIZE;
    if (insideMap(map, x, y, 580)) map.nodes.push({ id: col + ',' + row, col, row, x, y, neighbors: [] });
  }
  const lookup = new Map(map.nodes.map(n => [n.id, n]));
  const adjacent = n => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => lookup.get((n.col + dx) + ',' + (n.row + dy))).filter(Boolean);
  const entryNode = map.nodes.reduce((a, b) => b.x < a.x || b.x === a.x && Math.abs(b.y - WORLD_HEIGHT / 2) < Math.abs(a.y - WORLD_HEIGHT / 2) ? b : a);
  const exitNode = map.nodes.reduce((a, b) => b.x > a.x || b.x === a.x && Math.abs(b.y - WORLD_HEIGHT / 2) < Math.abs(a.y - WORLD_HEIGHT / 2) ? b : a);
  map.entry = { x: entryNode.x, y: entryNode.y }; map.exit = { x: exitNode.x, y: exitNode.y };
  const connect = (a, b) => { a.neighbors.push(b.id); b.neighbors.push(a.id); };
  // This is an interim connected street maze, not the deferred hierarchical template system.
  // Build a spanning tree, then add loops while protecting meaningful route length.
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < 32; attempt++) {
    for (const n of map.nodes) n.neighbors = [];
    const visited = new Set([entryNode.id]), stack = [entryNode];
    while (stack.length) {
      const n = stack.at(-1), choices = adjacent(n).filter(q => !visited.has(q.id));
      if (!choices.length) { stack.pop(); continue; }
      const q = choices[Math.floor(random() * choices.length)]; connect(n, q); visited.add(q.id); stack.push(q);
    }
    invalidateGraph(map);
    let route = blockRoute(map, entryNode, exitNode);
    const candidates = map.nodes.flatMap(n => adjacent(n).filter(q => n.id < q.id && !n.neighbors.includes(q.id)).map(q => [n, q]));
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    for (const [a, b] of candidates) {
      connect(a, b); invalidateGraph(map);
      const shorter = blockRoute(map, entryNode, exitNode);
      if (shorter.length < 44) { a.neighbors.pop(); b.neighbors.pop(); invalidateGraph(map); }
      else route = shorter;
    }
    // Reject late westward backtracking that the wall would consume. Budget a full minute at
    // spawn, conservative offset-passage travel, and two seconds of exploration per block.
    const clearance = Math.min(...route.map((n, i) => n.x - (-80 + i * 8 / 540 * (WORLD_WIDTH + 100))));
    const score = Math.abs(route.length - 48) + Math.max(0, 800 - clearance);
    if (score < bestScore) { bestScore = score; best = map.nodes.map(n => [...n.neighbors]); }
    if (score <= 4) break;
  }
  map.nodes.forEach((n, i) => n.neighbors = best[i]); invalidateGraph(map);
  const main = blockRoute(map, entryNode, exitNode);
  const edgeKey = (a, b) => [a.id, b.id].sort().join(':');
  const ports = new Map();
  for (const n of map.nodes) for (const id of n.neighbors) {
    const q = lookup.get(id), key = edgeKey(n, q); if (ports.has(key)) continue;
    const horizontal = n.col !== q.col, offset = range(-180, 180);
    ports.set(key, { x: (n.x + q.x) / 2 + (horizontal ? 0 : offset), y: (n.y + q.y) / 2 + (horizontal ? offset : 0) });
    map.streets.push({ a: { x: n.x, y: n.y }, port: ports.get(key), b: { x: q.x, y: q.y } });
  }
  const routePoints = nodes => nodes.flatMap((n, i) => i ? [ports.get(edgeKey(nodes[i - 1], n)), { x: n.x, y: n.y }] : [{ x: n.x, y: n.y }]);
  map.routes = [{ band: 'main', points: routePoints(main) }];
  for (const [band, pick] of [['top', (a, b) => b.y < a.y ? b : a], ['bottom', (a, b) => b.y > a.y ? b : a]]) {
    const anchor = map.nodes.reduce(pick), path = [...blockRoute(map, entryNode, anchor), ...blockRoute(map, anchor, exitNode).slice(1)];
    map.routes.push({ band, points: routePoints(path) });
  }
  Object.assign(context, { lookup, entryNode, exitNode, main, edgeKey, ports });
}
