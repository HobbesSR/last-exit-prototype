import { bodyRadius, sweptClear, TILE } from '../movement.ts';
import { cellCenter, discoveryGrid } from '../discovery.ts';
import { navigationClearance } from '../map/navigation.ts';
import { contestantKnowledge, createKnowledgePlanner, frozenKnowledge, packedTilesFor, type Knowledge, type KnownRoute, type KnownRouteStatus, type RouteSearch } from '../navigation/knowledge.ts';
import { closestOnSegment, type PackedTiles } from '../free-space.ts';
import { createPortalPlanner, portalGraphOf, regionAt, type PortalGraph, type Reach } from '../navigation/portal-graph.ts';
import { count, start, stop } from '../profiler.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import type { BuildingId, CollisionMap, Game, Gate, GateId, MatchContent, Player, Role, Tick, Vec2, World } from '../types.ts';
import { hypot } from '../math.ts';

// Planning over free-space tiles (22.6, #424). A contestant plans with what it knows; a gladiator
// with the whole map, as 15 has it, through the same planner. The route is the whole tentative
// path, walked on past its confirmed prefix: stepping into unknown ground is how the bot learns
// what is there.
//
// Unknown ground is planned as open, so learning more can only close a route or lengthen it, never
// open a shorter one elsewhere. A route therefore stands until its goal moves, the keys or door
// observations change, or a cell it was planned through as unknown becomes a known tile; not at
// every discovery sample, which would replan a moving bot twice a second for nothing.
interface Plan {
  /** The goal planned for, where the bot was, and when. */
  goal: Vec2;
  from: Vec2;
  at: Tick;
  status: KnownRouteStatus;
  keys: number;
  /** The door observations planned with, as `doorsSeen` writes them. */
  doors: string;
  /** Cells the route crosses whose tiles were unknown: when one becomes known, the route is replanned. */
  watch: number[];
  /** The route as planned, walked by shifting: a bot whose route is another array has had it cleared (`clearRoute`). */
  route: Vec2[];
  /**
   * A repair took up what changed but the next sliced repath must still run: a change was further on,
   * a door was seen opened, a running search was dropped, or the repair found no way through.
   */
  stale: boolean;
}
const plans = new WeakMap<Player, Plan>();
const planners = new WeakMap<CollisionMap, Map<Role, ReturnType<typeof createKnowledgePlanner>>>();
/** A goal that has moved this far is planned for afresh. */
const GOAL_MOVED: World = TILE;
/** Ticks between a bot's scheduled repaths, staggered by its place in the player list. */
const REPATH = 20;
/** A route still standing this long is replanned at the next scheduled repath regardless. */
const REPLAN_AFTER = 5 * HZ;
/**
 * A repath runs as one search of up to SLICED_BUDGET
 * expansions, at most SLICE of them a tick, while the bot walks the route it has. Its knowledge is
 * frozen when it starts, so the result is the route a whole search would have found then; what is
 * learnt meanwhile is caught by the usual checks once it is adopted. All bots' searches share
 * TICK_EXPANSIONS a tick, taken in player order, so searches that coincide queue rather than
 * add up on one tick.
 */
const SLICE = 2_000, SLICED_BUDGET = 100_000, TICK_EXPANSIONS = 3_000;
/**
 * Under `replanning: 'repair'` (#470 part 2), a contestant whose door observations or watched cells
 * change within REPAIR_NEAR of itself or of the next REPAIR_AHEAD of its route repairs the route at
 * once: one search of up to REPAIR_BUDGET expansions from where it stands to the waypoint
 * REPAIR_REJOIN past the change, the rest of the route kept. A change further on waits for the
 * sliced repath, as does one the repair cannot get round. A repair reserves its whole budget from
 * the tick's TICK_EXPANSIONS; when less than that is left, it waits for the next tick.
 */
const REPAIR_NEAR: World = 192, REPAIR_AHEAD: World = 384, REPAIR_REJOIN: World = 576, REPAIR_BUDGET = 500;
const allowances = new WeakMap<Game, { tick: Tick; left: number }>();

/** What is left of this tick's TICK_EXPANSIONS. Exported for its test. */
export function tickAllowance(s: Game): { tick: Tick; left: number } {
  let allowance = allowances.get(s);
  if (allowance?.tick !== s.tick) allowances.set(s, allowance = { tick: s.tick, left: TICK_EXPANSIONS });
  return allowance;
}
interface Search {
  search: RouteSearch;
  knowledge: Knowledge;
  goal: Vec2;
  /**
   * Where the bot has been while it ran, one place a tick from where it started: a way its body has
   * crossed, back to the route's start.
   */
  trail: Vec2[];
  /** The door observations it started with. */
  doors: string;
}
const searches = new WeakMap<Player, Search>();

/**
 * The tiles bots would otherwise build on their first plans, for whoever generates a map to build
 * beside it and the room to adopt (`adoptPackedTiles`). A gladiator plans over the whole map, so
 * its first plan reads every tile; a contestant reads only what it has discovered, a few at a time.
 */
export function prebuiltTiles(map: CollisionMap, _content: MatchContent): PackedTiles[] {
  return [packedTilesFor(map, 'gladiator')];
}

function plannerOf(map: CollisionMap, role: Role) {
  let byRole = planners.get(map);
  if (!byRole) planners.set(map, byRole = new Map());
  let planner = byRole.get(role);
  if (!planner) byRole.set(role, planner = createKnowledgePlanner(map, role));
  return planner;
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

/** The map's gates by id. Gates are only ever added, so the list's identity and length key it; each is read as it stands. */
function gatesById(map: CollisionMap): Map<GateId, Gate> {
  return botGates(map).byId;
}

/** The whole map as it stands: what a gladiator plans with. */
function fullKnowledge(s: Game, keys: number): Knowledge {
  const gates = gatesById(s.map);
  return { known: () => true, door: (id: GateId) => { const g = gates.get(id); return g && { open: g.open, locked: !!g.locked }; }, keys, revision: 0 };
}

/**
 * A contestant's door observations, to compare between plans. A gladiator's are the doors as they
 * stand; it does not watch them, since a door only ever stops being locked, which no route through
 * other doors needs to hear about.
 */
const doorsSeen = (p: Player): string => [...p.discovery?.gates ?? []].map(([id, g]) => `${id}:${+g.open}${+g.locked}`).join();

/** Cells along a route whose tiles the knowledge does not hold. */
function unknownAlong(planner: ReturnType<typeof createKnowledgePlanner>, knowledge: Knowledge, map: CollisionMap, points: readonly Vec2[]): number[] {
  const { cols, size } = discoveryGrid(map), cells = new Set<number>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, steps = Math.ceil(distance(a, b) / (size / 4));
    for (let k = 0; k <= steps; k++) {
      const x = a.x + (b.x - a.x) * k / steps, y = a.y + (b.y - a.y) * k / steps;
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) cells.add(Math.floor(y / size) * cols + Math.floor(x / size));
    }
  }
  return [...cells].filter(cell => !planner.support(cell).every(c => knowledge.known(c)));
}

/**
 * How much wider than the bot's body the planner keeps a route's legs from walls. A bot within it
 * of a leg can steer straight for the leg's end and stay in the cleared space, since its distance
 * from the leg only shrinks along the way.
 */
const margin = (p: Player): World => navigationClearance(p.role) - bodyRadius(p);
/** How far ahead a waypoint's next leg is swept before the bot turns onto it: within sight, so it reads nothing hidden. */
const TURN_AHEAD: World = 24;
/**
 * Whether the bot may turn from `waypoint` onto the leg to `next`. A taut route turns at corners an
 * obstacle's clearance away, so steering for the next point while still short of the corner cuts it
 * and presses into the obstacle: near a waypoint, the bot turns only once the first stretch of the
 * next leg is clear for its body, or when it is on the waypoint itself. Under `replanning: 'sliced'`
 * it must also be within `margin` of that leg, since the leg may run along a wall beyond the
 * stretch swept (#473 review); within 9 units steering slows to land on the waypoint, so it gets there.
 * Exported for its test.
 */
export function passed(s: Game, p: Player, waypoint: Vec2, next: Vec2): boolean {
  const d = distance(p, waypoint);
  if (d < 2) return true;
  if (d >= 11) return false;
  if (distance(p, closestOnSegment(p, waypoint, next)) > margin(p)) return false;
  const length = distance(p, next), t = Math.min(1, TURN_AHEAD / Math.max(length, 1e-9));
  return sweptClear(s.map, p, { x: p.x + (next.x - p.x) * t, y: p.y + (next.y - p.y) * t }, bodyRadius(p));
}

/**
 * Plan when due, and return the new route's status, or null when the bot keeps its route. Repaths
 * are staggered across bots by their place in the player list. A bot plans at once when its route
 * was cleared, or, having walked it out, when its goal or knowledge has changed or it has moved on
 * from where a route that stopped short began; a first plan, and a retry of a route that failed,
 * wait for its turn.
 */
export function repathTiles(s: Game, p: Player, target: Vec2): KnownRouteStatus | null {
  const contestant = p.role === 'contestant' && !!p.discovery;
  const knowledge = contestant ? contestantKnowledge(p.discovery!, p.keys) : fullKnowledge(s, p.keys);
  const planner = plannerOf(s.map, p.role), plan = plans.get(p);
  const scheduled = (s.tick + s.players.indexOf(p)) % REPATH === 0;
  let due = scheduled && !plan || !!plan && p.route !== plan.route;
  if (plan && !due && contestant && s.content.replanning === 'repair' && p.route?.length && distance(plan.goal, target) < GOAL_MOVED
    && plan.keys === knowledge.keys) due = repairNear(s, p, plan, planner, knowledge) === false;
  if (plan && !due) {
    const learnt = contestant && (plan.stale || plan.doors !== doorsSeen(p) || plan.watch.some(cell => planner.support(cell).every(c => knowledge.known(c))));
    const changed = learnt || distance(plan.goal, target) >= GOAL_MOVED || plan.keys !== knowledge.keys;
    // Ticks a contestant walks a route after learning something it has not yet planned with.
    if (learnt && p.route?.length) count('work.route.waiting');
    const short = plan.status === 'speculative' || plan.status === 'budget-exhausted';
    due = p.route?.length ? scheduled && (changed || s.tick - plan.at >= REPLAN_AFTER)
      : changed || short && distance(plan.from, p) >= 11 || scheduled && s.tick - plan.at >= REPATH;
  }
  return repathSliced(s, p, target, due, contestant, knowledge, planner);
}

/**
 * A repath spread over ticks: start a search when one is due and none is running for this goal,
 * advance the running one by a slice, and adopt its route when it ends. The bot walks its old
 * route meanwhile.
 */
function repathSliced(s: Game, p: Player, target: Vec2, due: boolean, contestant: boolean, knowledge: Knowledge,
  planner: ReturnType<typeof createKnowledgePlanner>): KnownRouteStatus | null {
  let running = searches.get(p);
  if (due && (!running || distance(running.goal, target) >= GOAL_MOVED || running.knowledge.keys !== knowledge.keys)) {
    count('work.repath');
    const { cols, rows } = discoveryGrid(s.map), frozen = frozenKnowledge(knowledge, cols * rows, s.map.gates.map(g => g.id));
    searches.set(p, running = { search: planner.search(frozen, p, target, SLICED_BUDGET), knowledge: frozen, goal: { x: target.x, y: target.y },
      trail: [], doors: contestant ? doorsSeen(p) : '' });
  }
  const last = running?.trail.at(-1);
  if (running && (!last || distance(last, p) >= 2)) running.trail.push({ x: p.x, y: p.y });
  const allowance = tickAllowance(s);
  if (!running || allowance.left <= 0) return null;
  start('sim.repath');
  const before = running.search.expansions, route = running.search.advance(Math.min(SLICE, allowance.left));
  allowance.left -= running.search.expansions - before;
  count('work.route.expansions', running.search.expansions - before); count('work.route.slices');
  if (route) {
    searches.delete(p);
    adopt(s, p, planner, route, running.knowledge, running.goal, running.doors, joinRoute(p, route.points, running.trail));
  }
  stop('sim.repath');
  return route?.status ?? null;
}

/**
 * Repair a contestant's route round what has changed near it (#470 part 2): door observations, and
 * cells it was planned through as unknown that now have known tiles. A change within REPAIR_NEAR of
 * the bot or of the next REPAIR_AHEAD of its route is searched round at once, from where the bot
 * stands to the waypoint REPAIR_REJOIN past it, and the rest of the route is kept. The plan then
 * takes up what changed; a change further on, a door seen opened, or a search running from before
 * leaves it stale for the next sliced repath. When the tick's allowance cannot cover REPAIR_BUDGET,
 * the plan is left as it was, so the change is still pending and the repair is tried next tick.
 * Returns null when nothing changed near the bot or the repair waits, true when the route was
 * repaired, and false when the repair found no way through, so the sliced repath starts now.
 */
function repairNear(s: Game, p: Player, plan: Plan, planner: ReturnType<typeof createKnowledgePlanner>, knowledge: Knowledge): boolean | null {
  const seen = doorsSeen(p), before = new Map(plan.doors.split(',').map(d => [d.slice(0, d.lastIndexOf(':')), d]));
  const gates = gatesById(s.map);
  // A door seen unlocked or open after being seen locked may shorten the route anywhere, not only here.
  const changes: Vec2[] = [];
  let opened = false;
  for (const d of seen ? seen.split(',') : []) {
    const id = d.slice(0, d.lastIndexOf(':')), g = gates.get(id as GateId), was = before.get(id);
    if (was === d || !g) continue;
    changes.push({ x: g.x, y: g.y });
    opened ||= !!was?.endsWith(':01');
  }
  for (const cell of plan.watch) if (planner.support(cell).every(c => knowledge.known(c))) changes.push(cellCenter(s.map, cell));
  if (!changes.length) return null;
  // Where along the route each change lies, and whether it is near the bot or the stretch ahead.
  const route = p.route ?? [], points = [{ x: p.x, y: p.y }, ...route];
  let reach = -1, far = false;
  for (const change of changes) {
    let nearest = Infinity, at = 0, along = 0, ahead = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!, b = points[i + 1]!, q = closestOnSegment(change, a, b), d = distance(change, q);
      if (d < nearest) { nearest = d; at = along + distance(a, q); }
      const length = distance(a, b);
      if (along < REPAIR_AHEAD) {
        const t = Math.min(1, (REPAIR_AHEAD - along) / Math.max(length, 1e-9));
        ahead = Math.min(ahead, distance(change, closestOnSegment(change, a, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })));
      }
      along += length;
    }
    if (Math.min(ahead, distance(p, change)) <= REPAIR_NEAR) reach = Math.max(reach, at); else far = true;
  }
  far ||= opened;
  if (reach < 0) return null;
  // The waypoint REPAIR_REJOIN past the furthest near change, or the route's end.
  let rejoin = route.length - 1;
  for (let i = 0, along = 0; i < route.length; i++) {
    along += distance(points[i]!, points[i + 1]!);
    if (along >= reach + REPAIR_REJOIN) { rejoin = i; break; }
  }
  const allowance = tickAllowance(s);
  if (allowance.left < REPAIR_BUDGET) { count('work.route.repairDeferred'); return null; }
  start('sim.repath'); count('work.route.repairs');
  const repair = planner.route(knowledge, p, route[rejoin]!, REPAIR_BUDGET);
  count('work.route.expansions', repair.expansions);
  allowance.left -= repair.expansions;
  const repaired = repair.status === 'complete' || repair.status === 'speculative';
  if (repaired) {
    p.route = [...repair.points.filter((point, i) => i > 0 || distance(p, point) >= 11), ...route.slice(rejoin + 1)].map(({ x, y }) => ({ x, y }));
    if (repair.status === 'speculative' && plan.status === 'complete') plan.status = 'speculative';
  } else count('work.route.repairFailed');
  // A search running from before this change would bring back a route that ignores it.
  const running = searches.delete(p);
  Object.assign(plan, { route: p.route, doors: seen, watch: unknownAlong(planner, knowledge, s.map, [{ x: p.x, y: p.y }, ...p.route ?? []]),
    stale: plan.stale || far || running || !repaired });
  stop('sim.repath');
  return repaired;
}

/** Make `route` the bot's plan, walked as `points`. */
function adopt(s: Game, p: Player, planner: ReturnType<typeof createKnowledgePlanner>, route: KnownRoute, knowledge: Knowledge, goal: Vec2,
  doors: string, points: readonly Vec2[]): void {
  const contestant = p.role === 'contestant' && !!p.discovery;
  if (route.status === 'budget-exhausted') count('work.route.exhausted');
  p.route = points.map(({ x, y }) => ({ x, y }));
  plans.set(p, { goal: { x: goal.x, y: goal.y }, from: { x: p.x, y: p.y }, at: s.tick, status: route.status, keys: knowledge.keys,
    doors, watch: contestant ? unknownAlong(planner, knowledge, s.map, route.points) : [], route: p.route, stale: false });
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

/**
 * A route planned from where the bot was when its search started, `trail[0]`, taken up from where
 * it is now. The planner keeps a route's legs `navigationClearance` from walls, wider than the
 * bot's body by a margin, so when the bot is within that margin of a segment, among those it could
 * have walked along, the way straight to the segment's end stays inside the cleared space (its
 * distance from the segment only shrinks along the way) and the bot joins there. Otherwise nothing
 * it knows says the way onto the route is clear, and it walks its trail back to the route's start.
 * Exported for its test.
 */
export function joinRoute(p: Player, points: readonly Vec2[], trail: readonly Vec2[]): Vec2[] {
  let walked = 0;
  for (let i = 1; i < trail.length; i++) walked += distance(trail[i - 1]!, trail[i]!);
  let best = 0, nearest = Infinity, along = 0;
  for (let i = 0; i + 1 < points.length && along <= walked + TILE; i++) {
    const d = distance(p, closestOnSegment(p, points[i]!, points[i + 1]!));
    if (d < nearest) { nearest = d; best = i; }
    along += distance(points[i]!, points[i + 1]!);
  }
  if (best + 1 < points.length && nearest <= margin(p)) return points.slice(best + 1);
  count('work.route.backtracked');
  return [...trail.slice(1).reverse(), ...points];
}
