/**
 * Contestant and hunter routes through a built map (53, "Routes"), with the grid baseline
 * retained alongside the bot planner until mesh adoption (#986). It is a lab
 * measurement, and feeds neither the report nor the sweep.
 */
import type { BuiltMap } from "../kernel/contract.ts";
import { builtMapCollision, builtMapFrame } from "../micro/adapter.ts";
import type { RegionElement } from "../micro/types.ts";
import { bodyRadius, sweptClear, TILE } from "../../shared/movement.ts";
import { navigationClearance, navigationMap } from "../../shared/map/navigation.ts";
import { createKnowledgePlanner, type KnownRouteStatus } from "../../shared/navigation/knowledge.ts";
import { gridRoute, navigationGrid, straightenPath, type TileCount, type TileIndex, type TileRect, type TileStep } from "./route.ts";
import type { CollisionMap, Role, Vec2 } from "../../shared/types.ts";

export type RouteMethod = "grid" | "mesh";

export interface BodyRoute {
  status: KnownRouteStatus | "not-found";
  role: Role;
  /** The clearance the game plans this body's routes with. */
  clearance: number;
  /** From the start to the target; empty unless the search completed. */
  points: Vec2[];
  /**
   * The search route's length in world units (tile centres for grid, taut path for mesh).
   * Null unless the search completed.
   */
  length: number | null;
  /**
   * The drawn route's length. Grid straightening is greedy (`straightenPath`) and can reverse
   * the bodies' length ordering. Mesh paths are already taut, so this equals `length`.
   */
  walked: number | null;
}

export interface RouteMeasure {
  method: RouteMethod;
  from: Vec2;
  to: Vec2;
  contestant: BodyRoute;
  hunter: BodyRoute;
  /**
   * Where the contestant's route passes ground a hunter can't: each run of its navigation tiles
   * that the hunter's walkability grid blocks, as tile centres. In mesh mode, contiguous
   * whole route legs refused by a hunter-clearance sweep; not precise bottleneck extents.
   */
  squeezes: Vec2[][];
  /** The hunter's search route length over the contestant's, when both reach the target. */
  ratio: number | null;
}

/**
 * Both bodies' routes from `from` to `to`, in the built map's own coordinates (cell × cell size).
 * Doors count as openable, as they do for a mover without keys; chain maps lock none (micro's
 * adapter).
 */
export function measureRoutes(built: BuiltMap<RegionElement>, from: Vec2, to: Vec2, method: RouteMethod = "grid"): RouteMeasure {
  const collision = builtMapCollision(built), { origin } = builtMapFrame(built);
  const world = (p: Vec2): Vec2 => ({ x: p.x + origin.x, y: p.y + origin.y });
  const local = (p: Vec2): Vec2 => ({ x: p.x - origin.x, y: p.y - origin.y });
  if (method === "mesh") return meshRoutes(collision, world(from), world(to), local);
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
  return { method, from, to, contestant: contestant.body, hunter: hunter.body, squeezes, ratio: c && h !== null ? h / c : null };
}

/** The bots' planner with complete layout and door knowledge, without dynamic-body avoidance. */
function meshRoutes(map: CollisionMap, from: Vec2, to: Vec2, local: (p: Vec2) => Vec2): RouteMeasure {
  const navMap = navigationMap(map, true);
  const knowledge = { known: () => true, door: () => ({ open: true, locked: false }), keys: 0, revision: 0 };
  const route = (role: Role): BodyRoute => {
    const clearance = navigationClearance(role);
    if (![from, to].every(p => sweptClear(navMap, p, p, bodyRadius({ role }))))
      return { role, clearance, status: "invalid-endpoint", points: [], length: null, walked: null };
    const result = createKnowledgePlanner(map, role).route(knowledge, from, to);
    // A budget-limited prefix is not a measured route to the target.
    if (result.status !== "complete")
      return { role, clearance, status: result.status, points: [], length: null, walked: null };
    return { role, clearance, status: result.status, points: result.points, length: result.length, walked: result.length };
  };
  const contestant = route("contestant"), hunter = route("gladiator"), squeezes: Vec2[][] = [];
  let run: Vec2[] | null = null;
  for (let i = 1; i < contestant.points.length; i++) {
    const a = contestant.points[i - 1]!, b = contestant.points[i]!;
    if (!sweptClear(navMap, a, b, hunter.clearance)) {
      if (!run) squeezes.push(run = [a]);
      run.push(b);
    } else run = null;
  }
  const c = contestant.length, h = hunter.length;
  return { method: "mesh", from: local(from), to: local(to),
    contestant: { ...contestant, points: contestant.points.map(local) },
    hunter: { ...hunter, points: hunter.points.map(local) },
    squeezes: squeezes.map(run => run.map(local)), ratio: c && h !== null ? h / c : null };
}

const centre = ([x, y]: TileStep): Vec2 => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });

function bodyRoute(map: CollisionMap, role: Role, from: Vec2, to: Vec2, steps: TileStep[] | null, local: (p: Vec2) => Vec2): BodyRoute {
  const clearance = navigationClearance(role);
  if (!steps) return { role, clearance, status: "not-found", points: [], length: null, walked: null };
  const points = [from, ...straightenPath(map, role, from, steps, true, Infinity).map(centre), to];
  return { role, clearance, status: "complete", points: points.map(local), length: polyline([from, ...steps.map(centre), to]), walked: polyline(points) };
}

function polyline(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return length;
}
