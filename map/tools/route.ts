import PF from 'pathfinding';
import { canOccupy, sweptClear, TILE } from '../../shared/movement.ts';
import { count, start, stop } from '../../shared/profiler.ts';
import { hypot } from '../../shared/math.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import type { CollisionMap, DoorPermission, Obstacle, Role, Vec2, World } from '../../shared/types.ts';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * A navigation-grid column or row: world units divided by `TILE`.
 */
export type TileIndex = Brand<number, 'TileIndex'>;
/** A count of tiles — a width, height or span rather than a position. */
export type TileCount = Brand<number, 'TileCount'>;

/** A point in tile space. */
export interface TilePoint {
  x: TileIndex;
  y: TileIndex;
}

/** A tile-space rectangle. `navigationGrid` bounds are this, never a world-space box. */
export interface TileRect {
  x: TileIndex;
  y: TileIndex;
  width: TileCount;
  height: TileCount;
}

/** A waypoint on a grid route, in absolute tile coordinates. */
export type TileStep = readonly [TileIndex, TileIndex];

/** World point at the centre of a navigation tile. */
const tileCentre = (step: TileStep): Vec2 => ({ x: (step[0] + 0.5) * TILE, y: (step[1] + 0.5) * TILE });
// How far ahead straightening will look for a waypoint it can reach directly. The scan runs from the
// furthest candidate back, so open ground costs one test and only genuinely blocked spans cost more.
const LOOKAHEAD = 6;
// A mover repaths long before it reaches the end of a route, so only the leading part is ever
// walked. Straightening past this is work the next repath throws away, and a route's tail is left as
// the grid returned it.
const STRAIGHTEN_SPAN = 400;

interface NavigationGridCache {
  /** Gate open/locked states, so a door change rebuilds rather than serving a stale grid. */
  key: string;
  obstacles: Obstacle[];
  count: number;
  grids: Map<string, number[][]>;
}

const navigationGridCache = new WeakMap<CollisionMap, NavigationGridCache>();

/** The map's cache, started afresh when its gates or obstacles have changed. */
function cacheOf(map: CollisionMap): NavigationGridCache {
  const gateKey = map.gates.map(g => `${Number(g.open)}${Number(!!g.locked)}`).join('');
  let cached = navigationGridCache.get(map);
  if (!cached || cached.key !== gateKey || cached.obstacles !== map.obstacles || cached.count !== map.obstacles.length) {
    cached = { key: gateKey, obstacles: map.obstacles, count: map.obstacles.length, grids: new Map<string, number[][]>() };
    navigationGridCache.set(map, cached);
  }
  return cached;
}

/**
 * Walkability for PathFinding, as `[y][x]` rows of 0 (walkable) or 1 (blocked).
 *
 * `bounds` is in tile space — `TILE`-sized navigation samples — not world units. The returned
 * matrix is indexed relative to `bounds`, so a caller adds `bounds.x`/`bounds.y` back to get
 * absolute tiles, and multiplies by `TILE` to reach world space.
 */
export function navigationGrid(map: CollisionMap, role: Role, bounds: TileRect = { x: 0 as TileIndex, y: 0 as TileIndex, width: Math.ceil(map.width / TILE) as TileCount, height: Math.ceil(map.height / TILE) as TileCount }, openDoors: DoorPermission = false): number[][] {
  const cached = cacheOf(map);
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

/**
 * Whether one absolute navigation tile is walkable for a body: the test `navigationGrid` fills its
 * matrix with, for a search that reads only some tiles of a large rectangle. Not cached.
 */
export function tileWalkable(map: CollisionMap, role: Role, openDoors: DoorPermission = false): (x: number, y: number) => boolean {
  const navMap = navigationMap(map, openDoors), clearance = navigationClearance(role);
  return (x, y) => canOccupy(navMap, (x + 0.5) * TILE, (y + 0.5) * TILE, clearance);
}

/**
 * Whether a body can travel straight between two points, swept (22.6, "Safety"): at navigation
 * clearance unless a smaller radius, such as the body's own, is given.
 */
export function moveClear(map: CollisionMap, role: Role, openDoors: DoorPermission = false, radius: World = navigationClearance(role)): (a: Vec2, b: Vec2) => boolean {
  const navMap = navigationMap(map, openDoors);
  return (a, b) => sweptClear(navMap, a, b, radius);
}

/** Can a body of `clearance` travel the straight line from `a` to `b` without leaving open ground? */
function travelClear(map: CollisionMap, a: Vec2, b: Vec2, clearance: World): boolean {
  const length = hypot(b.x - a.x, b.y - a.y);
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
 * Whether a point can step straight to a nearby tile centre without passing through a wall. Only the
 * line is tested, not the body's clearance: it tells the side of a thin wall a point is on.
 */
function stepClear(map: CollisionMap, openDoors: DoorPermission, from: Vec2, to: Vec2): boolean {
  return travelClear(navigationMap(map, openDoors), from, to, 4);
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
 * The result is still tile steps in absolute tile space. `span` is how far along the route to
 * straighten; a measurement of the whole route passes `Infinity`.
 */
export function straightenPath(map: CollisionMap, role: Role, origin: Vec2, path: TileStep[], openDoors: DoorPermission = false, span: World = STRAIGHTEN_SPAN): TileStep[] {
  if (path.length < 2) return path;
  count('work.pathStraighten');
  const navMap = navigationMap(map, openDoors), clearance = navigationClearance(role);
  const kept: TileStep[] = [];
  let from = origin, index = 0, travelled = 0;
  while (index < path.length && travelled < span) {
    let best = index;
    for (let ahead = Math.min(path.length - 1, index + LOOKAHEAD); ahead > index; ahead--) {
      if (travelClear(navMap, from, tileCentre(path[ahead]), clearance)) { best = ahead; break; }
    }
    kept.push(path[best]);
    const to = tileCentre(path[best]);
    travelled += hypot(to.x - from.x, to.y - from.y);
    from = to;
    index = best + 1;
  }
  return index < path.length ? kept.concat(path.slice(index)) : kept;
}

/**
 * The walkable tile nearest a point, searching outward up to five tiles; the point's own tile otherwise.
 * Tiles and point share one frame, whichever the caller indexes `walkable` in.
 * A body pressed against a wall thinner than a tile can have its own tile blocked and the next one over
 * on the far side of the wall; snapping there plans a route it cannot start. So the first tile it can
 * step to is preferred, in the same search order, and the first walkable tile is the fallback.
 */
export function nearestTile(walkable: (x: number, y: number) => boolean, point: Vec2, reachable: (centre: Vec2) => boolean): TilePoint {
  const t = { x: Math.floor(point.x / TILE) as TileIndex, y: Math.floor(point.y / TILE) as TileIndex };
  let fallback: TilePoint | null = null;
  for (let r = 0; r < 5; r++) for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) {
    if (!walkable(x, y)) continue;
    const node = { x: x as TileIndex, y: y as TileIndex };
    if (r === 0 || reachable({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE })) return node;
    fallback ??= node;
  }
  return fallback ?? t;
}

/**
 * The tiles from `from` to `to` within `bounds` (tile space), in absolute tiles, without the start
 * tile. Empty when they share a tile, and null when no route exists for this body.
 */
export function gridRoute(map: CollisionMap, role: Role, bounds: TileRect, from: Vec2, to: Vec2, openDoors: DoorPermission = false): TileStep[] | null {
  // The matrix the finder walks is indexed relative to `bounds`, so points go in less its origin
  // and steps come out plus it.
  const matrix = navigationGrid(map, role, bounds, openDoors);
  const local = (world: Vec2) => (centre: Vec2) => stepClear(map, openDoors, world, { x: centre.x + bounds.x * TILE, y: centre.y + bounds.y * TILE });
  const walkable = (x: number, y: number) => matrix[y]?.[x] === 0;
  const a = nearestTile(walkable, { x: from.x - bounds.x * TILE, y: from.y - bounds.y * TILE }, local(from));
  const b = nearestTile(walkable, { x: to.x - bounds.x * TILE, y: to.y - bounds.y * TILE }, local(to));
  start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
  const found = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(a.x, a.y, b.x, b.y, grid);
  if (!found.length) return null;
  return found.slice(1).map(([x, y]): TileStep => [(x + bounds.x) as TileIndex, (y + bounds.y) as TileIndex]);
}
