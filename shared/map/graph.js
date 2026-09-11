import { BLOCK_SIZE } from './world.js';
const graphCache = new WeakMap();
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

export function invalidateGraph(map) { graphCache.delete(map); }
