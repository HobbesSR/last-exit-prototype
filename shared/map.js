import { canOccupy, insideMap, TILE } from './movement.js';
import { count, start, stop } from './profiler.js';

export const WORLD_WIDTH = 24000, WORLD_HEIGHT = 12000;
export const BLOCK_SIZE = 1000;
const navigationCache = new WeakMap();
const graphCache = new WeakMap();
const gap = 300, wall = 40;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function blockAt(map, point) {
  return map.nodes?.find(n => Math.abs(n.x - point.x) <= BLOCK_SIZE / 2 && Math.abs(n.y - point.y) <= BLOCK_SIZE / 2)
    || map.nodes?.reduce((best, n) => !best || distance(n, point) < distance(best, point) ? n : best, null);
}
export function blockRoute(map, from, to) {
  if (!from || !to) return [];
  let cache = graphCache.get(map);
  if (!cache) { cache = new Map(); graphCache.set(map, cache); }
  const key = from.id + ':' + to.id;
  if (cache.has(key)) return cache.get(key);
  const nodes = new Map(map.nodes.map(n => [n.id, n])), queue = [from.id], previous = new Map([[from.id, null]]);
  for (let i = 0; i < queue.length && !previous.has(to.id); i++) for (const id of nodes.get(queue[i]).neighbors) {
    if (!previous.has(id)) { previous.set(id, queue[i]); queue.push(id); }
  }
  const route = [];
  if (previous.has(to.id)) for (let id = to.id; id !== null; id = previous.get(id)) route.push(nodes.get(id));
  route.reverse(); cache.set(key, route); return route;
}
export function generateMap(seed) {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const range = (a, b) => Math.round(a + random() * (b - a));
  const map = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [] };
  let serial = 0;
  const rect = (x, y, w, h, kind, extra = {}) => { const o = { id: 'o' + serial++, x, y, w, h, kind, ...extra }; map.obstacles.push(o); return o; };
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
    graphCache.delete(map);
    let route = blockRoute(map, entryNode, exitNode);
    const candidates = map.nodes.flatMap(n => adjacent(n).filter(q => n.id < q.id && !n.neighbors.includes(q.id)).map(q => [n, q]));
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    for (const [a, b] of candidates) {
      connect(a, b); graphCache.delete(map);
      const shorter = blockRoute(map, entryNode, exitNode);
      if (shorter.length < 44) { a.neighbors.pop(); b.neighbors.pop(); graphCache.delete(map); }
      else route = shorter;
    }
    // Reject late westward backtracking that the wall would consume. Budget a full minute at
    // spawn, conservative offset-passage travel, and two seconds of exploration per block.
    const clearance = Math.min(...route.map((n, i) => n.x - (-80 + i * 8 / 540 * (WORLD_WIDTH + 100))));
    const score = Math.abs(route.length - 48) + Math.max(0, 800 - clearance);
    if (score < bestScore) { bestScore = score; best = map.nodes.map(n => [...n.neighbors]); }
    if (score <= 4) break;
  }
  map.nodes.forEach((n, i) => n.neighbors = best[i]); graphCache.delete(map);
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
  const overlaps = (a, b, margin = 0) => a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
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
  const reservations = [];
  const reserve = (x, y, radius) => reservations.push({ x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 });
  for (const n of map.nodes) reserve(n.x, n.y, 110);
  reserve(entryNode.x, entryNode.y, 490); reserve(exitNode.x, exitNode.y, 300);
  // Spread contestants across four nearby connected blocks, rather than a single firing line.
  const startBlocks = [entryNode];
  for (let i = 0; i < startBlocks.length && startBlocks.length < 4; i++) for (const id of startBlocks[i].neighbors) {
    const n = lookup.get(id);
    if (!startBlocks.includes(n)) startBlocks.push(n);
    if (startBlocks.length === 4) break;
  }
  map.spawns = startBlocks.flatMap(n => [-200, 200].map(dy => ({ x: n.x - 100, y: n.y + dy })));
  for (const p of map.spawns) reserve(p.x, p.y, 165);
  for (const st of map.streets) {
    // Keep all center-to-port approaches free of props and building footprints.
    for (const a of [st.a, st.b]) {
      const steps = Math.ceil(distance(a, st.port) / 80);
      for (let i = 0; i <= steps; i++) reserve(a.x + (st.port.x - a.x) * i / steps, a.y + (st.port.y - a.y) * i / steps, 85);
    }
  }
  const clearFootprint = box => insideMap(map, box.x + box.w / 2, box.y + box.h / 2, Math.hypot(box.w, box.h) / 2)
    && !map.obstacles.some(o => overlaps(box, o, 20)) && !reservations.some(r => overlaps(box, r, 10));
  const spots = [];
  for (const [index, n] of map.nodes.entries()) {
    const kind = ['yard', 'depot', 'garden'][range(0, 2)];
    const module = { id: index, x: n.x, y: n.y, width: BLOCK_SIZE, height: BLOCK_SIZE, kind }; map.modules.push(module);
    const corners = [[-390, -390], [140, -390], [-390, 140], [140, 140]];
    for (const [i, [dx, dy]] of corners.entries()) {
      const box = { x: n.x + dx, y: n.y + dy, w: 250, h: 250 };
      if (!clearFootprint(box)) continue;
      if (i === index % 4 && index % 2 === 0) {
        const building = { id: 'building-' + serial++, ...box, nodeId: n.id }; map.buildings.push(building);
        // Door in south wall; two north-facing windows admit sight and bullets, never bodies.
        const extra = { buildingId: building.id };
        rect(box.x, box.y, 65, 18, 'building', extra);
        rect(box.x + 65, box.y, 60, 18, 'window', extra);
        rect(box.x + 125, box.y, 60, 18, 'window', extra);
        rect(box.x + 185, box.y, 65, 18, 'building', extra);
        rect(box.x, box.y + 18, 18, 214, 'building', extra); rect(box.x + 232, box.y + 18, 18, 214, 'building', extra);
        rect(box.x, box.y + 232, 75, 18, 'building', extra); rect(box.x + 175, box.y + 232, 75, 18, 'building', extra);
        map.gates.push({ id: 'door-' + serial++, x: box.x + 125, y: box.y + 241, w: 100, h: 18, open: false, locked: index % 10 === 0, kind: 'door', buildingId: building.id });
        spots.push({ x: box.x + 125, y: box.y + 125, nodeId: n.id, buildingId: building.id });
        reservations.push({ x: box.x - 30, y: box.y - 30, w: 310, h: 350 });
      } else {
        const prop = { x: box.x + range(0, 90), y: box.y + range(0, 90), w: range(65, 140), h: range(65, 140) };
        if (clearFootprint(prop)) rect(prop.x, prop.y, prop.w, prop.h, kind === 'depot' ? 'container' : 'crate', { color: index % 3 });
      }
    }
    // Loot courtyard is in a different quarter than the through-route center.
    spots.push({ x: n.x + 220, y: n.y - 220, nodeId: n.id });
  }
  const occupied = [];
  function place(x, y, kind, extra = {}, separation = 55) {
    if (!canOccupy(map, x, y, 24) || occupied.some(p => distance(p, { x, y }) < separation)) return null;
    const item = { id: 'item-' + serial++, x, y, kind, ...extra }; map.items.push(item); occupied.push(item); return item;
  }
  // One easy starter weapon per separated spawn.
  for (const spawn of map.spawns) place(spawn.x + 40, spawn.y, 'weapon', { weaponType: 'pistol' });
  place(entryNode.x - 100, entryNode.y + 240, 'access'); place(entryNode.x + 100, entryNode.y + 240, 'access');
  for (const [i, n] of main.entries()) if (i > 3 && i < main.length - 3 && i % 6 === 0) {
    const station = { id: 'rail-' + serial++, x: n.x, y: n.y, nodeId: n.id }; map.stations.push(station); occupied.push(station);
  }
  map.stations.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const index of [10, 20, 30]) if (main[index]) { const n = main[index]; map.sensors.push({ id: 'sensor-' + serial++, x: n.x + 80, y: n.y - 80 }); }
  // Put objective choices in upper and lower neighborhoods rather than on one centerline.
  const objectiveNodes = map.nodes.filter(n => n.x > WORLD_WIDTH * 0.18 && n.x < WORLD_WIDTH * 0.75);
  for (const [i, n] of objectiveNodes.entries()) if (i % 9 === 0) {
    const charger = { id: 'charger-' + serial++, x: n.x - 130, y: n.y + 100, nodeId: n.id };
    if (canOccupy(map, charger.x, charger.y, 30) && occupied.every(o => distance(o, charger) > 90)) { map.chargers.push(charger); occupied.push(charger); }
  }
  for (const [i, spot] of spots.entries()) {
    if (!spot.buildingId && distance(spot, entryNode) < 800 || !canOccupy(map, spot.x, spot.y, 24)) continue;
    const kind = spot.buildingId ? (i % 3 === 0 ? 'cell' : 'weapon') : i % 7 === 0 ? 'cell' : ['weapon', 'med', 'shield', 'access'][range(0, 3)];
    place(spot.x, spot.y, kind, { ...(kind === 'weapon' ? { weaponType: ['pistol', 'rifle', 'scattergun'][range(0, 2)] } : {}), ...(spot.buildingId ? { buildingId: spot.buildingId } : {}) });
  }
  // Add early outdoor cells, so finding a building is a choice, not an undocumented prerequisite.
  for (const n of main.slice(1, 5)) place(n.x - 120, n.y + 100, 'cell');
  for (const [i, n] of map.nodes.entries()) if (i % 11 === 0 && distance(n, entryNode) > 2500) {
    const point = { x: n.x + 130, y: n.y + 100 };
    if (!canOccupy(map, point.x, point.y, 25) || occupied.some(o => distance(o, point) < 100) || map.chargers.some(st => distance(st, point) < 850)) continue;
    const kind = ['mine', 'turret', 'flame', 'spider'][range(0, 3)];
    map.traps.push({ id: 'trap-' + serial++, kind, ...point, homeX: point.x, homeY: point.y, heading: -Math.PI / 2, offset: range(0, 159), cooldown: 35, spent: false }); occupied.push(point);
  }
  return map;
}
export function navigationGrid(map, role, bounds = { x: 0, y: 0, width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) }, openDoors = false) {
  const gateKey = map.gates.map(g => `${Number(g.open)}${Number(!!g.locked)}`).join('');
  let cached = navigationCache.get(map);
  if (!cached || cached.key !== gateKey || cached.obstacles !== map.obstacles || cached.count !== map.obstacles.length) {
    cached = { key: gateKey, obstacles: map.obstacles, count: map.obstacles.length, grids: new Map(), maps: new Map() }; navigationCache.set(map, cached);
  }
  const key = [role, bounds.x, bounds.y, bounds.width, bounds.height, openDoors].join(':');
  count('calls.navigationGrid');
  if (!cached.grids.has(key)) {
    start('sim.navGridRebuild'); count('work.navGridRebuild');
    if (!cached.maps.has(openDoors)) cached.maps.set(openDoors, openDoors ? { ...map, gates: map.gates.filter(g => openDoors !== 'all' && g.locked) } : map);
    const navMap = cached.maps.get(openDoors);
    const matrix = Array.from({ length: bounds.height }, (_, y) => Array.from({ length: bounds.width }, (_, x) => canOccupy(navMap, (x + bounds.x + 0.5) * TILE, (y + bounds.y + 0.5) * TILE, role === 'gladiator' ? 25 : 14) ? 0 : 1));
    if (cached.grids.size >= 60) cached.grids.delete(cached.grids.keys().next().value);
    cached.grids.set(key, matrix); stop('sim.navGridRebuild');
  }
  return cached.grids.get(key);
}
