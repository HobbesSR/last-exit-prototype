import { canOccupy, TILE } from '../movement.ts';
import { count, start, stop } from '../profiler.ts';
import type { CollisionMap, DoorPermission, Gate, Obstacle, Role, TileCount, TileIndex, TileRect, TileStep, Vec2, World } from '../types.ts';

/**
 * The clearance a planned route requires, padded past the body radius in `movement.ts` so a route is
 * not planned flush against a wall. Both the walkability grid and the straightening that follows it
 * read this one value: smoothing against a narrower radius would cut the very corners the grid was
 * built to keep clear of.
 */
export const navigationClearance = (role: Role): World => role === 'gladiator' ? 25 : 14;
/** World point at the centre of a navigation tile. */
const tileCentre = (step: TileStep): Vec2 => ({ x: (step[0] + 0.5) * TILE, y: (step[1] + 0.5) * TILE });
// How far ahead straightening will look for a waypoint it can reach directly. The scan runs from the
// furthest candidate back, so open ground costs one test and only genuinely blocked spans cost more.
const LOOKAHEAD = 6;
// A mover repaths long before it reaches the end of a route, so only the leading part is ever
// walked. Straightening past this is work the next repath throws away, and a route's tail is left as
// the grid returned it.
const STRAIGHTEN_SPAN = 400;

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
    const navMap = navigationMap(map, openDoors);
    const matrix = Array.from({ length: bounds.height }, (_, y) => Array.from({ length: bounds.width }, (_, x) => canOccupy(navMap, (x + bounds.x + 0.5) * TILE, (y + bounds.y + 0.5) * TILE, navigationClearance(role)) ? 0 : 1));
    if (cached.grids.size >= 60) cached.grids.delete(cached.grids.keys().next().value!);
    cached.grids.set(key, matrix); stop('sim.navGridRebuild');
  }
  return cached.grids.get(key)!;
}

/** The map a route is planned against: the real one, minus whichever gates the mover may open. */
function navigationMap(map: CollisionMap, openDoors: DoorPermission): CollisionMap {
  const cached = navigationCache.get(map);
  if (!cached) return openDoors ? { ...map, gates: map.gates.filter((g: Gate) => openDoors !== 'all' && g.locked) } : map;
  if (!cached.maps.has(openDoors)) cached.maps.set(openDoors, openDoors ? { ...map, gates: map.gates.filter((g: Gate) => openDoors !== 'all' && g.locked) } : map);
  return cached.maps.get(openDoors)!;
}

/** Can a body of `clearance` travel the straight line from `a` to `b` without leaving open ground? */
function travelClear(map: CollisionMap, a: Vec2, b: Vec2, clearance: World): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  // Samples one clearance apart overlap by half a radius, so anything actually crossing the segment
  // falls inside at least one of them. Spacing them wider would let a thin wall slip between tests.
  const steps = Math.max(1, Math.ceil(length / clearance));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!canOccupy(map, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, clearance)) return false;
  }
  return true;
}

/**
 * Drop the waypoints a mover can simply walk past.
 *
 * A grid search returns tile centres, so a route at any angle other than a multiple of 45 degrees
 * comes back as a staircase. Steering to each centre in turn makes a bot change heading every few
 * ticks and read as jitter, and no amount of presentation smoothing can remove it because the
 * motion is real — the simulation genuinely turned. Straightening replaces each run of steps with
 * the furthest waypoint the body can reach directly, which is the path the route always meant.
 *
 * The result is still tile steps in absolute tile space, so it stays the same shape the snapshot and
 * the recording carry.
 */
export function straightenPath(map: CollisionMap, role: Role, origin: Vec2, path: TileStep[], openDoors: DoorPermission = false): TileStep[] {
  if (path.length < 2) return path;
  count('work.pathStraighten');
  const navMap = navigationMap(map, openDoors), clearance = navigationClearance(role);
  const kept: TileStep[] = [];
  let from = origin, index = 0, span = 0;
  while (index < path.length && span < STRAIGHTEN_SPAN) {
    let best = index;
    for (let ahead = Math.min(path.length - 1, index + LOOKAHEAD); ahead > index; ahead--) {
      if (travelClear(navMap, from, tileCentre(path[ahead]), clearance)) { best = ahead; break; }
    }
    kept.push(path[best]);
    const to = tileCentre(path[best]);
    span += Math.hypot(to.x - from.x, to.y - from.y);
    from = to;
    index = best + 1;
  }
  return index < path.length ? kept.concat(path.slice(index)) : kept;
}
