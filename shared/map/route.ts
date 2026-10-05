import PF from 'pathfinding';
import { TILE } from '../movement.ts';
import { start, stop } from '../profiler.ts';
import { navigationGrid } from './navigation.ts';
import type { CollisionMap, DoorPermission, Role, TileIndex, TilePoint, TileRect, TileStep, Vec2 } from '../types.ts';

/**
 * The game's route search: A* over the walkability grid `navigationGrid` gives a body. Bots plan
 * with it, and the Map Lab measures routes through a built map with it (53, "Routes"), so the two
 * can't disagree about where a body fits. It is not in `shared/map.ts`, which the browser client
 * loads without the `pathfinding` package.
 */

/** The walkable tile nearest a point, searching outward up to five tiles; the point's own tile otherwise. */
function nearestNode(matrix: number[][], point: Vec2): TilePoint {
  const t = { x: Math.floor(point.x / TILE) as TileIndex, y: Math.floor(point.y / TILE) as TileIndex };
  for (let r = 0; r < 5; r++) for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) if (matrix[y]?.[x] === 0) return { x: x as TileIndex, y: y as TileIndex };
  return t;
}

/**
 * The tiles from `from` to `to` within `bounds` (tile space), in absolute tiles, without the start
 * tile. Empty when they share a tile, and null when no route exists for this body.
 */
export function gridRoute(map: CollisionMap, role: Role, bounds: TileRect, from: Vec2, to: Vec2, openDoors: DoorPermission = false): TileStep[] | null {
  // The matrix the finder walks is indexed relative to `bounds`, so points go in less its origin
  // and steps come out plus it.
  const matrix = navigationGrid(map, role, bounds, openDoors);
  const a = nearestNode(matrix, { x: from.x - bounds.x * TILE, y: from.y - bounds.y * TILE });
  const b = nearestNode(matrix, { x: to.x - bounds.x * TILE, y: to.y - bounds.y * TILE });
  start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
  const found = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(a.x, a.y, b.x, b.y, grid);
  if (!found.length) return null;
  return found.slice(1).map(([x, y]): TileStep => [(x + bounds.x) as TileIndex, (y + bounds.y) as TileIndex]);
}
