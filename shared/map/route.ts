import PF from 'pathfinding';
import { TILE } from '../movement.ts';
import { start, stop } from '../profiler.ts';
import { navigationGrid, stepClear } from './navigation.ts';
import type { CollisionMap, DoorPermission, Role, TileIndex, TilePoint, TileRect, TileStep, Vec2 } from '../types.ts';

/**
 * The game's route search: A* over the walkability grid `navigationGrid` gives a body. Bots plan
 * with it, and the Map Lab measures routes through a built map with it (53, "Routes"), so the two
 * can't disagree about where a body fits. It is not in `shared/map.ts`, which the browser client
 * loads without the `pathfinding` package.
 */

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
