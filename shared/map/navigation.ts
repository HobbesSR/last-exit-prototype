import { canOccupy, TILE } from '../movement.ts';
import { count, start, stop } from '../profiler.ts';
import type { CollisionMap, DoorPermission, Gate, Obstacle, Role, TileCount, TileIndex, TileRect } from '../types.ts';

interface NavigationCache {
  /** Gate open/locked states, so a door change rebuilds rather than serving a stale grid. */
  key: string;
  obstacles: Obstacle[];
  count: number;
  grids: Map<string, number[][]>;
  maps: Map<DoorPermission, CollisionMap>;
}

const navigationCache = new WeakMap<CollisionMap, NavigationCache>();

/**
 * Walkability for PathFinding, as `[y][x]` rows of 0 (walkable) or 1 (blocked).
 *
 * `bounds` is in tile space — `TILE`-sized navigation samples — not world units. The returned
 * matrix is indexed relative to `bounds`, so a caller adds `bounds.x`/`bounds.y` back to get
 * absolute tiles, and multiplies by `TILE` to reach world space.
 */
export function navigationGrid(map: CollisionMap, role: Role, bounds: TileRect = { x: 0 as TileIndex, y: 0 as TileIndex, width: Math.ceil(map.width / TILE) as TileCount, height: Math.ceil(map.height / TILE) as TileCount }, openDoors: DoorPermission = false): number[][] {
  const gateKey = map.gates.map(g => `${Number(g.open)}${Number(!!g.locked)}`).join('');
  let cached = navigationCache.get(map);
  if (!cached || cached.key !== gateKey || cached.obstacles !== map.obstacles || cached.count !== map.obstacles.length) {
    cached = { key: gateKey, obstacles: map.obstacles, count: map.obstacles.length, grids: new Map<string, number[][]>(), maps: new Map<DoorPermission, CollisionMap>() }; navigationCache.set(map, cached);
  }
  const key = [role, bounds.x, bounds.y, bounds.width, bounds.height, openDoors].join(':');
  count('calls.navigationGrid');
  if (!cached.grids.has(key)) {
    start('sim.navGridRebuild'); count('work.navGridRebuild');
    if (!cached.maps.has(openDoors)) cached.maps.set(openDoors, openDoors ? { ...map, gates: map.gates.filter((g: Gate) => openDoors !== 'all' && g.locked) } : map);
    const navMap = cached.maps.get(openDoors)!;
    const matrix = Array.from({ length: bounds.height }, (_, y) => Array.from({ length: bounds.width }, (_, x) => canOccupy(navMap, (x + bounds.x + 0.5) * TILE, (y + bounds.y + 0.5) * TILE, role === 'gladiator' ? 25 : 14) ? 0 : 1));
    if (cached.grids.size >= 60) cached.grids.delete(cached.grids.keys().next().value!);
    cached.grids.set(key, matrix); stop('sim.navGridRebuild');
  }
  return cached.grids.get(key)!;
}
