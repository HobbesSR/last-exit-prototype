import type { CollisionMap, DoorPermission, Gate, Obstacle, Role, World } from '../types.ts';

/**
 * The clearance a planned route requires, padded past the body radius in `movement.ts` so a route is
 * not planned flush against a wall. Both the walkability grid and the straightening that follows it
 * read this one value: smoothing against a narrower radius would cut the very corners the grid was
 * built to keep clear of.
 */
export const navigationClearance = (role: Role): World => role === 'gladiator' ? 25 : 14;

interface NavigationCache {
  /** Gate open/locked states, so a door change rebuilds rather than serving a stale grid. */
  key: string;
  obstacles: Obstacle[];
  count: number;
  maps: Map<DoorPermission, CollisionMap>;
}

const navigationCache = new WeakMap<CollisionMap, NavigationCache>();

/** The map's cache, started afresh when its gates or obstacles have changed. */
function cacheOf(map: CollisionMap): NavigationCache {
  const gateKey = map.gates.map(g => `${Number(g.open)}${Number(!!g.locked)}`).join('');
  let cached = navigationCache.get(map);
  if (!cached || cached.key !== gateKey || cached.obstacles !== map.obstacles || cached.count !== map.obstacles.length) {
    cached = { key: gateKey, obstacles: map.obstacles, count: map.obstacles.length, maps: new Map<DoorPermission, CollisionMap>() };
    navigationCache.set(map, cached);
  }
  return cached;
}

/** The map a route is planned against: the real one, minus whichever gates the mover may open. */
export function navigationMap(map: CollisionMap, openDoors: DoorPermission): CollisionMap {
  const cached = cacheOf(map);
  if (!cached.maps.has(openDoors)) {
    cached.maps.set(openDoors, openDoors ? { ...map, gates: map.gates.filter((g: Gate) => openDoors !== 'all' && g.locked) } : map);
  }
  return cached.maps.get(openDoors)!;
}
