import { packedTilesFor } from '../navigation/knowledge.ts';
import type { PackedTiles } from '../free-space.ts';
import { createPortalPlanner, portalGraphOf, regionAt, type PortalGraph, type Reach } from '../navigation/portal-graph.ts';
import { count } from '../profiler.ts';
import type { BuildingId, CollisionMap, Gate, GateId, Game, MatchContent, Player, Vec2 } from '../types.ts';
import { hypot } from '../math.ts';

// What remains of the TypeScript bot planner (22.6): the tiles and gate tables a match prepares, which the core's planner
// reads (`rust/core/src/tick/bots/`), and a gladiator's portal legs, which `tools/runtime-map-measure.mjs` and the
// core's parity check (`tests/core-navigation.test.js`) use until #1349 settles them. The planner itself retired (#1358).

/**
 * The tiles bots would otherwise build on their first plans, for whoever generates a map to build
 * beside it and the room to adopt (`adoptPackedTiles`). A gladiator plans over the whole map, so
 * its first plan reads every tile; a contestant reads only what it has discovered, a few at a time.
 */
export function prebuiltTiles(map: CollisionMap, _content: MatchContent): PackedTiles[] {
  return [packedTilesFor(map, 'gladiator')];
}

export interface BotGateIndex {
  count: number;
  byId: Map<GateId, Gate>;
  byBuilding: Map<BuildingId, Gate[]>;
}
const gateIndex = new WeakMap<Gate[], BotGateIndex>();
export function botGates(map: CollisionMap): BotGateIndex {
  let index = gateIndex.get(map.gates);
  if (index?.count !== map.gates.length) {
    const byId = new Map<GateId, Gate>();
    const byBuilding = new Map<BuildingId, Gate[]>();
    for (const g of map.gates) {
      byId.set(g.id, g);
      if (g.buildingId !== undefined) {
        let list = byBuilding.get(g.buildingId);
        if (!list) byBuilding.set(g.buildingId, list = []);
        list.push(g);
      }
    }
    gateIndex.set(map.gates, index = { count: map.gates.length, byId, byBuilding });
  }
  return index;
}

/** Prepare the gates' two lookup tables without observing doors or planning. */
export async function prepareBotGates(map: CollisionMap, yieldControl: () => Promise<void>): Promise<void> {
  const byId = new Map<GateId, Gate>(), byBuilding = new Map<BuildingId, Gate[]>();
  for (let i = 0; i < map.gates.length; i++) {
    const g = map.gates[i]!;
    byId.set(g.id, g);
    if (g.buildingId !== undefined) {
      let list = byBuilding.get(g.buildingId);
      if (!list) byBuilding.set(g.buildingId, list = []);
      list.push(g);
    }
    if (i % 128 === 127) await yieldControl();
  }
  gateIndex.set(map.gates, { count: map.gates.length, byId, byBuilding });
}

// A gladiator's trip across regions under `hunterPlanning: 'portals'` (#682, 22.6): the portal graph
// gives the regions to pass through, and the tile search plans only as far as the crossing after
// next. A region promises each of its portals is reachable from every other (20.1), so the top level
// costs a crossing by its straight-line length; the leg's search finds the real way. Bot-private.
interface Corridor {
  goal: Vec2;
  goalRegion: number;
  /** `regions[i]` is the region the bot is in before crossing `waypoints[i]`; the last waypoint is the goal. */
  regions: number[];
  waypoints: Vec2[];
  /** The leg's search found no way to a crossing: head for the goal itself until it changes region. */
  direct: boolean;
}
const corridors = new WeakMap<Player, Corridor>();
const straightReach: Reach = (from, targets) => targets.map(t => hypot(t.x - from.x, t.y - from.y));
const portalPlanners = new WeakMap<PortalGraph, ReturnType<typeof createPortalPlanner>>();

/** Where a gladiator's leg ends: the crossing after the next one, or its goal when that is in this region or the next. */
export function legGoal(s: Game, p: Player, target: Vec2): Vec2 {
  const graph = portalGraphOf(s.map);
  const from = graph ? regionAt(graph, p) : -1, to = graph ? regionAt(graph, target) : -1;
  if (!graph || from < 0 || to < 0 || from === to) { corridors.delete(p); return target; }
  let corridor = corridors.get(p);
  if (!corridor || corridor.goalRegion !== to || !corridor.direct && !corridor.regions.includes(from)) {
    let planner = portalPlanners.get(graph);
    if (!planner) portalPlanners.set(graph, planner = createPortalPlanner(graph, straightReach, 'straight'));
    count('work.route.portalPlans');
    const route = planner.route(p, target);
    const regions = [from];
    for (const portal of route.portals) {
      const [a, b] = graph.portals[portal]!.regions, at = regions.at(-1)!;
      regions.push(a === at ? b : a);
    }
    corridors.set(p, corridor = { goal: { x: target.x, y: target.y }, goalRegion: to, regions, waypoints: route.waypoints, direct: route.status !== 'complete' });
  }
  if (corridor.direct) return target;
  const at = corridor.regions.lastIndexOf(from);
  return at + 1 >= corridor.waypoints.length - 1 ? target : corridor.waypoints[at + 1]!;
}

/** A leg that cannot be planned is given up: the gladiator plans for its goal itself until the goal changes region. */
export function abandonLeg(p: Player): void {
  count('work.route.abandonedLeg');
  const corridor = corridors.get(p);
  if (corridor) corridor.direct = true;
}

