import { canOccupy, TILE } from '../movement.js';
import { count, start, stop } from '../profiler.js';
const navigationCache = new WeakMap();
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
