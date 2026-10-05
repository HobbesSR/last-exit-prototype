/**
 * Contestant and hunter routes through a built map (53, "Routes"): what the game's own route
 * search finds for each body between two points, on the built map's collision. It is a lab
 * measurement, and feeds neither the report nor the sweep.
 */
import type { BuiltMap } from "../kernel/contract.ts";
import { builtMapCollision, builtMapFrame } from "../micro/adapter.ts";
import type { RegionElement } from "../micro/types.ts";
import { TILE } from "../../shared/movement.ts";
import { navigationClearance, navigationGrid, straightenPath } from "../../shared/map/navigation.ts";
import { gridRoute } from "../../shared/map/route.ts";
import type { CollisionMap, Role, TileCount, TileIndex, TileRect, TileStep, Vec2 } from "../../shared/types.ts";

export interface BodyRoute {
  role: Role;
  /** The clearance the game plans this body's routes with. */
  clearance: number;
  /** From the start to the target, straightened as a mover would walk it; empty when unreachable. */
  points: Vec2[];
  /**
   * The grid route's length in world units, through each navigation tile's centre: the shortest
   * route the game's search finds. Null when unreachable.
   */
  length: number | null;
  /**
   * The straightened route's length, as drawn. Straightening is greedy (`straightenPath`), so it
   * can come out a little longer on one body's route than the other's for the same ground.
   */
  walked: number | null;
}

export interface RouteMeasure {
  from: Vec2;
  to: Vec2;
  contestant: BodyRoute;
  hunter: BodyRoute;
  /**
   * Where the contestant's route passes ground a hunter can't: each run of its navigation tiles
   * that the hunter's walkability grid blocks, as tile centres.
   */
  squeezes: Vec2[][];
  /** The hunter's grid route length over the contestant's, when both reach the target. */
  ratio: number | null;
}

/**
 * Both bodies' routes from `from` to `to`, in the built map's own coordinates (cell × cell size).
 * Doors count as openable, as they do for a mover without keys; chain maps lock none (micro's
 * adapter).
 */
export function measureRoutes(built: BuiltMap<RegionElement>, from: Vec2, to: Vec2): RouteMeasure {
  const collision = builtMapCollision(built), { origin } = builtMapFrame(built);
  const world = (p: Vec2): Vec2 => ({ x: p.x + origin.x, y: p.y + origin.y });
  const local = (p: Vec2): Vec2 => ({ x: p.x - origin.x, y: p.y - origin.y });
  const bounds: TileRect = { x: 0 as TileIndex, y: 0 as TileIndex, width: Math.ceil(collision.width / TILE) as TileCount, height: Math.ceil(collision.height / TILE) as TileCount };
  const a = world(from), b = world(to);
  const route = (role: Role) => {
    const steps = gridRoute(collision, role, bounds, a, b, true);
    return { steps, body: bodyRoute(collision, role, a, b, steps, local) };
  };
  const contestant = route("contestant"), hunter = route("gladiator");
  const hunterGrid = navigationGrid(collision, "gladiator", bounds, true);
  const squeezes: Vec2[][] = [];
  let run: Vec2[] | null = null;
  for (const [x, y] of contestant.steps ?? []) {
    if (hunterGrid[y]![x] === 1) (run ??= []).push(local(centre([x, y])));
    else if (run) {
      squeezes.push(run);
      run = null;
    }
  }
  if (run) squeezes.push(run);
  const c = contestant.body.length, h = hunter.body.length;
  return { from, to, contestant: contestant.body, hunter: hunter.body, squeezes, ratio: c && h !== null ? h / c : null };
}

const centre = ([x, y]: TileStep): Vec2 => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });

function bodyRoute(map: CollisionMap, role: Role, from: Vec2, to: Vec2, steps: TileStep[] | null, local: (p: Vec2) => Vec2): BodyRoute {
  const clearance = navigationClearance(role);
  if (!steps) return { role, clearance, points: [], length: null, walked: null };
  const points = [from, ...straightenPath(map, role, from, steps, true, Infinity).map(centre), to];
  return { role, clearance, points: points.map(local), length: polyline([from, ...steps.map(centre), to]), walked: polyline(points) };
}

function polyline(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return length;
}
