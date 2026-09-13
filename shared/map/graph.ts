import { BLOCK_SIZE } from './world.ts';
import type { GameMap, MapNode, NodeId, Vec2, World } from '../types.ts';

/** The map fields the block graph reads. Routing runs during generation, before the map is whole. */
type GraphMap = Pick<GameMap, 'nodes'>;

const graphCache = new WeakMap<GraphMap, Map<string, MapNode[]>>();
const distance = (a: Vec2, b: Vec2): World => Math.hypot(a.x - b.x, a.y - b.y);
export function blockAt(map: GraphMap, point: Vec2): MapNode | null {
  return map.nodes?.find(n => Math.abs(n.x - point.x) <= BLOCK_SIZE / 2 && Math.abs(n.y - point.y) <= BLOCK_SIZE / 2)
    || map.nodes?.reduce<MapNode | null>((best, n) => !best || distance(n, point) < distance(best, point) ? n : best, null)
    || null;
}
export function blockRoute(map: GraphMap, from: MapNode | null | undefined, to: MapNode | null | undefined): MapNode[] {
  if (!from || !to) return [];
  let cache = graphCache.get(map);
  if (!cache) { cache = new Map(); graphCache.set(map, cache); }
  const key = from.id + ':' + to.id;
  if (cache.has(key)) return cache.get(key)!;
  const nodes = new Map(map.nodes.map(n => [n.id, n] as const)), queue: NodeId[] = [from.id], previous = new Map<NodeId, NodeId | null>([[from.id, null]]);
  for (let i = 0; i < queue.length && !previous.has(to.id); i++) for (const id of nodes.get(queue[i])!.neighbors) {
    if (!previous.has(id)) { previous.set(id, queue[i]); queue.push(id); }
  }
  const route: MapNode[] = [];
  if (previous.has(to.id)) for (let id: NodeId | null = to.id; id !== null; id = previous.get(id) ?? null) route.push(nodes.get(id)!);
  route.reverse(); cache.set(key, route); return route;
}

export function invalidateGraph(map: GraphMap): void { graphCache.delete(map); }
