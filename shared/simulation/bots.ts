import { bodyRadius, canOccupy, insideMap, lineClear, reachClear, sweptClear, TILE } from '../movement.ts';
import { cellCenter, cellIndexAt, discoveryGrid, isFeatureDiscovered, DISCOVERY_INTERVAL } from '../discovery.ts';
import { straightenPath, blockAt, blockRoute } from '../map.ts';
import { navigationClearance } from '../map/navigation.ts';
import { gridRoute } from '../map/route.ts';
import { contestantKnowledge, createKnowledgePlanner, frozenKnowledge, packedTilesFor, type Knowledge, type KnownRoute, type KnownRouteStatus, type RouteSearch } from '../navigation/knowledge.ts';
import { closestOnSegment, type PackedTiles } from '../free-space.ts';
import { count, start, stop } from '../profiler.ts';
import { carriedCell, sameQuality, syncWeapon } from '../equipment.ts';
import { GATE_REACH, HZ } from './rules.ts';
import { distance, center, clearRoute } from './geometry.ts';
import { visibleTo } from './visibility.ts';
import { dynamicWaypoint } from './dynamic-navigation.ts';
import { attack, utilityApplies, utilityOutcome } from './combat.ts';
import { dropEquipment, dropInventorySlot } from './loot.ts';
import { reloadableRounds, reserveRoom } from './ammo.ts';
import type { CollisionMap, DiscoveryMemory, Gate, GateId, GroundItem, Game, ItemId, MatchContent, Player, PlayerInput, Role, Tick, TileCount, TileIndex, Vec2, WeaponItem, World } from '../types.ts';
import { atan2, cos, hypot, sin } from '../math.ts';

// What a bot that decides from discovery is after, kept between ticks (#230). A bot searching for what
// it needs heads for the frontier of what it has *seen*: loot needs line of sight, so a cell the view
// window has discovered may still hide it (15). It keeps one unseen cell beside a seen one until the cell
// is seen, so it does not dither, and gives a cell up for good when it cannot be routed to, when it has
// stood inside the cell for a sample and still not seen it (a cell whose centre is solid never will be),
// or when it stops getting closer. Nearness is not arrival: a roofed cell stays concealed until the bot
// is under its roof (#354 review). An item it stops getting closer to, such as one seen
// through a window, is set aside for a while. Bot-private, never projected or recorded.
interface Pursuit {
  /** The frontier cell being explored toward, or -1, and the tick the bot entered it, or -1 while outside. */
  cell: number;
  entered: number;
  abandoned: Set<number>;
  /** Items set aside, until the tick they may be chased again. */
  ignored: Map<ItemId, Tick>;
  /** The goal being watched for progress, the closest the bot has come to it, and when it last got closer. */
  goal: string;
  closest: World;
  progressed: Tick;
}
const pursuits = new WeakMap<Player, Pursuit>();
/** How much a cell's lead toward the extraction side (+x) is worth against its distance. */
const EXPLORE_RIGHTWARD = 0.5;
/** Frontier cells this close to the wall are not worth the trip. */
const EXPLORE_HAZARD_MARGIN = 300;
/** A goal not approached by PROGRESS within STALL ticks is given up; a set-aside item returns after IGNORE_FOR. */
const STALL = 6 * HZ, PROGRESS: World = 16, IGNORE_FOR = 30 * HZ;
const NEIGHBOURS = [[1, 0], [0, 1], [0, -1], [-1, 0]] as const;

function pursuitOf(p: Player): Pursuit {
  let state = pursuits.get(p);
  if (!state) pursuits.set(p, state = { cell: -1, entered: -1, abandoned: new Set(), ignored: new Map(), goal: '', closest: Infinity, progressed: 0 as Tick });
  return state;
}

/** Track approach to `goal` at `at`; true once the bot has stopped getting closer to it. */
function stalled(s: Game, p: Player, state: Pursuit, goal: string, at: Vec2): boolean {
  const d = distance(p, at);
  if (state.goal !== goal) state.goal = goal;
  else if (d >= state.closest - PROGRESS) return s.tick - state.progressed > STALL;
  state.closest = d; state.progressed = s.tick;
  return false;
}

function exploreTarget(s: Game, p: Player, memory: DiscoveryMemory): Vec2 | null {
  const state = pursuitOf(p), seen = memory.seen ?? memory.discovered;
  if (state.cell >= 0) {
    const centre = cellCenter(s.map, state.cell);
    const settled = seen.has(state.cell) || centre.x <= s.hazardX + EXPLORE_HAZARD_MARGIN || !ground(s, memory, state.cell, centre);
    const inside = cellIndexAt(s.map, p.x, p.y) === state.cell;
    if (!inside) state.entered = -1; else if (state.entered < 0) state.entered = s.tick;
    const arrived = inside && s.tick - state.entered > DISCOVERY_INTERVAL;
    if (!settled && !arrived && !stalled(s, p, state, `cell:${state.cell}`, centre)) return centre;
    if (!seen.has(state.cell)) state.abandoned.add(state.cell);
    state.cell = -1;
  }
  const { cols, rows } = discoveryGrid(s.map);
  count('work.bots.frontier', seen.size);
  let best = -1, bestScore = Infinity;
  // Sight order is deterministic, and ties keep the first, so the choice is too.
  for (const index of seen) {
    const col = index % cols, row = (index - col) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc, r = row + dr, next = r * cols + c;
      if (c < 0 || r < 0 || c >= cols || r >= rows || seen.has(next) || state.abandoned.has(next)) continue;
      const centre = cellCenter(s.map, next);
      if (centre.x <= s.hazardX + EXPLORE_HAZARD_MARGIN || !ground(s, memory, next, centre)) continue;
      const score = distance(p, centre) - (centre.x - p.x) * EXPLORE_RIGHTWARD;
      if (score < bestScore) { bestScore = score; best = next; }
    }
  }
  if (best < 0) return null;
  state.cell = best; state.entered = -1;
  // A new destination: route to it now rather than finish the old route first. Over tiles a moved goal is replanned anyway.
  if (s.content.navigation !== 'tiles') clearRoute(p);
  return cellCenter(s.map, best);
}

/**
 * Whether a cell may be ground worth exploring. Planning over tiles reads only what the bot knows: a
 * cell the view window has covered shows whether its centre is ground, and any other is assumed to be,
 * inside the public world bounds (22.6). The grid planner reads the truth, as it always has.
 */
function ground(s: Game, memory: DiscoveryMemory, cell: number, centre: Vec2): boolean {
  if (s.content.navigation === 'tiles' && !memory.surveyed?.has(cell)) return true;
  return insideMap(s.map, centre.x, centre.y);
}

function abandonExploration(p: Player): void {
  const state = pursuits.get(p);
  if (state && state.cell >= 0) { state.abandoned.add(state.cell); state.cell = -1; }
}

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
 * Expansions one repath may make. A query across a 36 × 18 map with everything known makes about
 * 60,000 (about 110 ms), too long for one tick; at the budget the bot walks to the place searched
 * nearest its goal and plans on from there (22.6, "budget-exhausted").
 */
const BOT_ROUTE_BUDGET = 12_000;
/**
 * Under `replanning: 'sliced'` (#470), a repath runs as one search of up to SLICED_BUDGET
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
/** Whether repaths spread over ticks: `sliced`, and `repair`, which adds local repair. */
const sliced = (s: Game): boolean => s.content.replanning === 'sliced' || s.content.replanning === 'repair';

/**
 * The tiles bots would otherwise build on their first plans, for whoever generates a map to build
 * beside it and the room to adopt (`adoptPackedTiles`). A gladiator plans over the whole map, so
 * its first plan reads every tile; a contestant reads only what it has discovered, a few at a time.
 */
export function prebuiltTiles(map: CollisionMap, content: MatchContent): PackedTiles[] {
  return content.navigation === 'tiles' ? [packedTilesFor(map, 'gladiator')] : [];
}

function plannerOf(map: CollisionMap, role: Role) {
  let byRole = planners.get(map);
  if (!byRole) planners.set(map, byRole = new Map());
  let planner = byRole.get(role);
  if (!planner) byRole.set(role, planner = createKnowledgePlanner(map, role));
  return planner;
}

/** The whole map as it stands: what a gladiator plans with. */
function fullKnowledge(s: Game, keys: number): Knowledge {
  const gates = new Map(s.map.gates.map(g => [g.id, g]));
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
  if (sliced(s) && distance(p, closestOnSegment(p, waypoint, next)) > margin(p)) return false;
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
function repathTiles(s: Game, p: Player, target: Vec2): KnownRouteStatus | null {
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
  if (sliced(s)) return repathSliced(s, p, target, due, contestant, knowledge, planner);
  if (!due) return null;
  start('sim.repath'); count('work.repath');
  const route = planner.route(knowledge, p, target, BOT_ROUTE_BUDGET);
  count('work.route.expansions', route.expansions);
  adopt(s, p, planner, route, knowledge, target, contestant ? doorsSeen(p) : '', route.points.filter((point, i) => i > 0 || distance(p, point) >= 11));
  stop('sim.repath');
  return route.status;
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
  const gates = new Map(s.map.gates.map(g => [g.id, g]));
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

export interface BotIntent {
  input: PlayerInput;
  /** A utility to activate after selecting input.slot, before movement. */
  utilitySlot?: number;
  /** Equipment to discard when pursuing a cell with a full inventory. */
  discardSlot?: number;
}

/** Collect equipment/utility/drop intents without applying them; private planning memory,
 * routes, sliced searches and their shared per-tick allowance may still change. */
export function collectBotIntent(s: Game, p: Player): BotIntent { return decideBot(s, p, true); }

/** Legacy bot behavior, including its pre-movement side effects. */
export function botInput(s: Game, p: Player): PlayerInput { return decideBot(s, p, false).input; }

function decideBot(s: Game, p: Player, collecting: boolean): BotIntent {
  const intent: BotIntent = { input: {} };
  const cell = carriedCell(p);
  let spentUtility = -1;
  let effectiveHp = p.hp;
  if (p.inventory) {
    const utility = p.inventory.findIndex(i => !!i && (i.kind === 'med' && p.hp < 65 || i.kind === 'shield' && p.shield < 45));
    const loaded = p.inventory.findIndex(i => i?.kind === 'weapon' && (i.ammo ?? s.content.weapons[i.weaponType].ammo) > 0);
    // Under L2 an empty weapon that a reload can fill is still worth holding.
    const weapon = loaded >= 0 || !s.content.reloading ? loaded : p.inventory.findIndex(i => i?.kind === 'weapon' && reloadableRounds(s, p, i) > 0);
    const selected = utility >= 0 ? utility : weapon >= 0 ? weapon : 0;
    if (collecting) {
      intent.input.slot = selected;
      if (utility >= 0 && p.attackCd <= 0 && p.role === 'contestant') {
        const item = p.inventory[utility]!;
        const outcome = utilityOutcome(p, item);
        if (outcome && utilityApplies(p, item)) {
          effectiveHp = outcome.hp;
          intent.utilitySlot = utility;
          if (item.count <= 1) spentUtility = utility;
        }
      }
    } else {
      p.selectedSlot = selected; syncWeapon(p, s.content.weapons);
      if (utility >= 0) attack(s, p);
    }
  }
  if (!collecting) effectiveHp = p.hp;
  const effectiveInventory = () => p.inventory!.map((item, slot) => slot === spentUtility ? null : item);
  // Mixed temperaments create occasional betrayal, rather than every converging bot starting
  // a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes.
  const opportunistic = p.id.charCodeAt(p.id.length - 1) % 3 === 0;
  start('sim.bots.sight');
  const nearest = s.players.filter(t => t.id !== p.id && (t.role !== p.role || p.aggressor === t.id && s.tick < p.aggressionUntil!
    || p.role === 'contestant' && opportunistic && s.tick > 30 * HZ && distance(p, t) < (s.tick > 120 * HZ ? 320 : 180))
    && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  stop('sim.bots.sight');
  let target: Vec2 = p.role === 'gladiator' ? nearest || s.map.stations.find(st => st.x > s.hazardX + 1200) || s.map.exit : s.map.exit;
  let exploring = false;
  const tiles = s.content.navigation === 'tiles';
  if (p.role === 'contestant') {
    // A contestant knows what it has discovered (15, #230). Without discovery (content-1) it keeps the
    // whole map, which is what the frozen characterization traces recorded.
    start('sim.bots.items');
    const memory = p.discovery, pursuit = memory ? pursuitOf(p) : null;
    const known = (feature: Vec2) => !memory || isFeatureDiscovered(memory, s.map, feature);
    count('work.bots.items', memory ? memory.items?.size ?? 0 : s.map.items.length);
    const items = memory ? [...memory.items?.values() ?? []].filter(i => !(pursuit!.ignored.get(i.id)! > s.tick)) : s.map.items;
    // Over tiles, a door is locked when the bot last saw it locked; the grid planner reads the doors as they stand.
    const locked = (g: Gate) => { const seen = tiles ? memory?.gates?.get(g.id) : g; return !!seen && !!seen.locked && !seen.open; };
    const accessible = (i: GroundItem) => p.keys > 0 || !i.buildingId || !s.map.gates.some(g => g.buildingId === i.buildingId && locked(g));
    const charged = !!cell && cell.charge >= s.content.cellChargeTicks;
    const objective: Vec2[] = !cell ? items.filter(i => i.kind === 'cell' && i.x > s.hazardX + 100 && accessible(i))
      : !charged ? s.map.chargers.filter(st => st.x > s.hazardX + 100 && known(st)) : [];
    if (memory && !objective.length && !(charged && known(s.map.exit))) {
      // Nothing it needs is known: search for it, and fall back on the exit only once nothing is left to search.
      stop('sim.bots.items'); start('sim.bots.explore');
      const frontier = exploreTarget(s, p, memory);
      stop('sim.bots.explore'); start('sim.bots.items');
      if (frontier) { target = frontier; exploring = true; } else if (!known(s.map.exit)) target = p;
    }
    if (objective.length) {
      // Over tiles, nearest first: the street graph is truth, and a chain map has none anyway.
      const from = tiles ? null : blockAt(s.map, p);
      const cost = (t: Vec2) => from === null ? distance(p, t) : blockRoute(s.map, from, blockAt(s.map, t)).length * 1000 + distance(p, t) * 0.05;
      target = objective.sort((a, b) => cost(a) - cost(b))[0];
      if (!cell && (collecting ? effectiveInventory() : p.inventory!).every(Boolean)) {
        const discard = (collecting ? effectiveInventory() : p.inventory!).findIndex(item => item?.kind !== 'weapon' || item.ammo === 0 && !reloadableRounds(s, p, item));
        if (discard >= 0) {
          if (collecting) intent.discardSlot = discard;
          else if (s.content.itemInstances) dropInventorySlot(s, p, discard);
          else { dropEquipment(s, p, p.inventory![discard]!); p.inventory![discard] = null; }
        }
      }
    }
    const inventory = collecting ? effectiveInventory().map((item, slot) => slot === intent.discardSlot ? null : item) : p.inventory!;
    // A matching weapon refills its magazine, or under L2 the family reserve it would feed.
    const room = (slot: WeaponItem) => reserveRoom(s, p, s.content.reloading!.weapons[slot.weaponType].family);
    const refills = (slot: WeaponItem) => s.content.reloading ? room(slot) > 0 : slot.ammo < s.content.weapons[slot.weaponType]?.maxAmmo;
    const full = (slot: WeaponItem) => s.content.reloading ? room(slot) <= 0 : slot.ammo >= s.content.weapons[slot.weaponType].maxAmmo;
    const loot = items.filter(i => i.kind !== 'cell' && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && accessible(i)
      && (i.kind !== 'med' || effectiveHp < 75)
      && (i.kind === 'ammo' ? reserveRoom(s, p, i.family) > 0 : i.kind === 'access' || inventory.some(slot => !slot) || inventory.some(slot => slot?.kind === i.kind && slot.kind !== 'weapon' && slot.kind !== 'cell' && slot.count < 3 && sameQuality(slot, i)
        || slot?.kind === 'weapon' && slot.weaponType === i.weaponType && sameQuality(slot, i) && refills(slot)))
      && (i.kind !== 'weapon' || i.ammo !== 0 && !inventory.some(slot => slot?.kind === 'weapon' && slot.weaponType === i.weaponType && sameQuality(slot, i) && full(slot)))).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && loot.kind !== 'cell' && !p.charging && (!nearest || distance(p, nearest) > 250)) { target = loot; exploring = false; }
    stop('sim.bots.items');
    if (pursuit && !exploring) {
      pursuit.cell = -1;
      const item = target as Partial<GroundItem>;
      if (item.kind && item.id && stalled(s, p, pursuit, item.id, target)) { pursuit.ignored.set(item.id, s.tick + IGNORE_FOR as Tick); clearRoute(p); }
      else if (!item.kind) pursuit.goal = '';
    }
  }
  start('sim.bots.plan');
  if (tiles) {
    const status = repathTiles(s, p, target);
    if (status === 'no-known-route' || status === 'invalid-endpoint') {
      if (exploring) abandonExploration(p);
      // A known dead end sets the item aside, as a stall would; it is not given up for good (22.6).
      const item = target as Partial<GroundItem>, pursuit = pursuits.get(p);
      if (pursuit && item.kind && item.id) { pursuit.ignored.set(item.id, s.tick + IGNORE_FOR as Tick); clearRoute(p); }
    }
  // The replan phase comes from the name's length (B04, #368). That is recorded behaviour: changing it
  // is a deliberate gameplay change with its own version and fixture decision, never cleanup.
  } else if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
    start('sim.repath'); count('work.repath');
    // The coarse street graph supplies the next block; local collision-aware A* handles its passage.
    const route = blockRoute(s.map, blockAt(s.map, p), blockAt(s.map, target));
    const localTarget = route.length > 1 ? route[1] : target;
    // `bx`/`by` are the search's origin in absolute tiles.
    const bx = Math.max(0, Math.floor((Math.min(p.x, localTarget.x) - 600) / TILE)) as TileIndex;
    const by = Math.max(0, Math.floor((Math.min(p.y, localTarget.y) - 600) / TILE)) as TileIndex;
    const bounds = { x: bx, y: by, width: Math.min(Math.ceil((Math.max(p.x, localTarget.x) + 600) / TILE), Math.ceil(s.map.width / TILE)) - bx as TileCount, height: Math.min(Math.ceil((Math.max(p.y, localTarget.y) + 600) / TILE), Math.ceil(s.map.height / TILE)) - by as TileCount };
    const found = gridRoute(s.map, p.role, bounds, p, localTarget, p.keys > 0 ? 'all' : true);
    if (!found && exploring) abandonExploration(p);
    const steps = found ?? [];
    // A grid route is a staircase wherever it runs at an angle the grid cannot express. Walking it
    // waypoint by waypoint is what makes a bot visibly wobble, so the redundant steps come out here
    // rather than being smoothed over by the renderer, which could not remove real turning anyway.
    p.path = straightenPath(s.map, p.role, p, steps, p.keys > 0 ? 'all' : true);
    stop('sim.repath');
  }
  stop('sim.bots.plan'); start('sim.bots.steer');
  let waypoint = tiles ? p.route?.[0] ?? target : p.path?.[0] ? center(...p.path[0]) : target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else if (tiles) { while (p.route?.length && passed(s, p, p.route[0]!, p.route[1] ?? target)) p.route.shift(); waypoint = p.route?.[0] ?? target; }
  else if (distance(p, waypoint) < 11 && p.path?.length) { p.path.shift(); waypoint = p.path[0] ? center(...p.path[0]) : target; }
  let dx = waypoint.x - p.x, dy = waypoint.y - p.y;
  stop('sim.bots.steer'); start('sim.bots.sight');
  const hunter = p.role === 'contestant' && s.players.find(t => t.role === 'gladiator' && t.status === 'active' && distance(p, t) < 170 && visibleTo(s, p, t));
  if (hunter) {
    // Keep firing, but do not blindly follow an objective path straight into melee range.
    const away = atan2(p.y - hunter.y, p.x - hunter.x);
    const goalLength = Math.max(1, hypot(dx, dy));
    const options = [0, -0.5, 0.5, -1, 1, -1.5, 1.5].map(offset => {
      const x = cos(away + offset), y = sin(away + offset);
      const point = { x: p.x + x * 90, y: p.y + y * 90 };
      return { x, y, point, score: distance(point, hunter) + (x * dx + y * dy) / goalLength * 15 - (point.x < s.hazardX + 100 ? 1000 : 0) };
    }).filter(o => canOccupy(s.map, o.point.x, o.point.y, 12) && reachClear(s.map, p, o.point)).sort((a, b) => b.score - a.score);
    if (options.length) { dx = options[0].x * 9; dy = options[0].y * 9; }
  }
  stop('sim.bots.sight');
  if (s.content.dynamicNavigation) {
    start('sim.bots.dynamic');
    const next = dynamicWaypoint(s, p, { x: p.x + dx, y: p.y + dy });
    dx = next.x - p.x; dy = next.y - p.y;
    stop('sim.bots.dynamic');
  }
  const length = Math.max(9, hypot(dx, dy));
  if (p.role === 'contestant' && cell != null && cell.charge < s.content.cellChargeTicks && s.map.chargers.some(st => distance(p, st) < 55 && lineClear(s.map, p, st))) {
    intent.input = { ...intent.input, x: 0, y: 0, interact: true }; return intent;
  }
  const allyInLine = p.role === 'contestant' && nearest && s.players.some(other => {
    if (other.id === p.id || other.id === nearest.id || other.role !== 'contestant' || other.status !== 'active') return false;
    const nx = nearest.x - p.x, ny = nearest.y - p.y, projection = ((other.x - p.x) * nx + (other.y - p.y) * ny) / (nx * nx + ny * ny);
    return projection > 0 && projection < 1 && hypot(other.x - p.x - projection * nx, other.y - p.y - projection * ny) < 28;
  });
  if (s.content.reloading && p.role === 'contestant') {
    // Reload when empty, or topping up when no one is in sight. Never automatic for humans (14).
    const held = p.inventory?.[(collecting ? intent.input.slot : p.selectedSlot) ?? -1];
    if (held?.kind === 'weapon' && reloadableRounds(s, p, held) > 0 && (held.ammo === 0 || !nearest)) intent.input.reload = true;
  }
  intent.input = { ...intent.input, x: dx / length, y: dy / length, aim: nearest ? atan2(nearest.y - p.y, nearest.x - p.x) : s.content.dynamicNavigation && dx === 0 && dy === 0 ? p.heading : atan2(dy, dx), attack: !!nearest && !allyInLine && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || s.map.gates.some(g => !g.open && distance(p, g) < GATE_REACH) || p.x < s.hazardX + 200 };
  return intent;
}
