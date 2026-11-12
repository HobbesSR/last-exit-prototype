import { canOccupy, gatesNear, insideMap, lineClear, reachClear } from '../movement.ts';
import { cellCenter, cellIndexAt, discoveryGrid, isFeatureDiscovered, DISCOVERY_CELL_SIZE, DISCOVERY_INTERVAL } from '../discovery.ts';
import { navigationClearance } from '../map/navigation.ts';
import { contestantKnowledge } from '../navigation/knowledge.ts';
import { count, start, stop } from '../profiler.ts';
import { carriedCell, sameQuality } from '../equipment.ts';
import { GATE_REACH, HZ, TRANSIT_REACH } from './rules.ts';
import { giveUpSweep, noteHunterTarget, sweepTarget, transitPlan } from './hunting.ts';
import { distance, clearRoute } from './geometry.ts';
import { visibleTo } from './visibility.ts';
import { dynamicWaypoint } from './dynamic-navigation.ts';
import { utilityApplies, utilityOutcome } from './combat.ts';
import { reloadableRounds, reserveRoom } from './ammo.ts';
import { heardBy } from './hearing.ts';
import { rememberedItems, seenCells } from './bot-memory.ts';
import { abandonLeg, botGates, legGoal, passed, repathTiles } from './bot-routes.ts';
import type { DiscoveryMemory, Game, Gate, GroundItem, ItemId, Player, PlayerInput, StationId, Tick, Vec2, WeaponItem, World } from '../types.ts';
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

function exploreTarget(s: Game, p: Player, memory: DiscoveryMemory, avoid: readonly Vec2[] = []): Vec2 | null {
  const state = pursuitOf(p), { cols, rows } = discoveryGrid(s.map), seen = seenCells(memory, cols, rows);
  // A cautious contestant turns from a cell near fresh gunfire (#685): set aside while heard, not given up.
  const loud = (centre: Vec2) => avoid.some(cue => distance(cue, centre) < AVOID_CUE);
  if (state.cell >= 0 && loud(cellCenter(s.map, state.cell))) state.cell = -1;
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
  // The frontier is kept as cells are seen (#864): unseen cells beside a seen one, in the order a scan of the seen
  // set meets them. Ties keep the first, so the choice is deterministic.
  const frontier = seen.frontier;
  count('work.bots.frontier', frontier.size);
  let best = -1, bestScore = Infinity;
  for (const next of frontier) {
    if (state.abandoned.has(next)) continue;
    const centre = cellCenter(s.map, next);
    if (centre.x <= s.hazardX + EXPLORE_HAZARD_MARGIN || !ground(s, memory, next, centre) || loud(centre)) continue;
    const score = distance(p, centre) - (centre.x - p.x) * EXPLORE_RIGHTWARD;
    if (score < bestScore) { bestScore = score; best = next; }
  }
  if (best < 0) return null;
  state.cell = best; state.entered = -1;
  return cellCenter(s.map, best);
}

/**
 * Whether a cell may be ground worth exploring. A bot reads only what it knows: a cell the view window
 * has covered shows whether its centre is ground, and any other is assumed to be, inside the public
 * world bounds (22.6).
 */
function ground(s: Game, memory: DiscoveryMemory, cell: number, centre: Vec2): boolean {
  if (!memory.surveyed?.has(cell)) return true;
  return insideMap(s.map, centre.x, centre.y);
}

function abandonExploration(p: Player): void {
  const state = pursuits.get(p);
  if (state && state.cell >= 0) { state.abandoned.add(state.cell); state.cell = -1; }
}

// Heard gunfire as a lead (#685, 14 "Heard gunfire"). A cue fades in seconds, far sooner than a bot can cross the map
// to it, so a bot remembers where it last heard a shot, as it remembers an item it has seen (15): only what it heard,
// never the shooter. The newest shot replaces the lead. The bot drops it on arrival, when it stops getting closer,
// when it finds no way there, or after LEAD_FOR. Bot-private, never projected or recorded.
interface Lead extends Vec2 {
  /** The tick the shot was heard: a later one replaces this lead, the same one never revives it. */
  tick: Tick;
  since: Tick;
  closest: World;
  progressed: Tick;
  done: boolean;
}
const leads = new WeakMap<Player, Lead>();
/** Within LEAD_ARRIVE of the cell's centre the bot has arrived; it gives up after LEAD_STALL without approaching, or LEAD_FOR. */
const LEAD_ARRIVE: World = 400, LEAD_STALL = 10 * HZ, LEAD_FOR = 60 * HZ;
/** A cautious contestant explores no cell within AVOID_CUE of a shot it can still hear. */
const AVOID_CUE: World = 900;

/** Where `p` is following heard gunfire to, if anywhere. Call it every tick while bots react, so the lead keeps up. */
function leadOf(s: Game, p: Player): Lead | null {
  const newest = heardBy(p, s.tick).at(-1);
  let lead = leads.get(p);
  if (newest && (!lead || newest.tick > lead.tick)) {
    const at = standingIn(s, p, newest);
    leads.set(p, lead = { x: at.x, y: at.y, tick: newest.tick, since: s.tick, closest: Infinity, progressed: s.tick, done: false });
  }
  if (!lead || lead.done) return null;
  const d = distance(p, lead);
  if (d < LEAD_ARRIVE || s.tick - lead.since > LEAD_FOR) { lead.done = true; return null; }
  if (d < lead.closest - PROGRESS) { lead.closest = d; lead.progressed = s.tick; }
  else if (s.tick - lead.progressed > LEAD_STALL) { lead.done = true; return null; }
  return lead;
}

// A cue names a cell, and its centre may be inside a building: head for the nearest spot in the cell the bot can stand on.
// A gladiator knows the whole map (15). A contestant judges only what it knows (15, 22.6.2): a cell it has not
// discovered is planned as open, so it heads for the centre; in a known cell only static geometry counts, since doors
// are the planner's to judge from what it observed, and only spots whose body lies inside that cell, so geometry in an
// unknown neighbour cannot decide the choice.
const CELL_OFFSETS = (() => {
  const offsets: Vec2[] = [];
  for (let y = -96; y <= 96; y += 32) for (let x = -96; x <= 96; x += 32) offsets.push({ x, y });
  return offsets.sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y));
})();
function standingIn(s: Game, p: Player, centre: Vec2): Vec2 {
  const radius = navigationClearance(p.role), memory = p.role === 'contestant' ? p.discovery : undefined;
  if (memory) {
    const cell = cellIndexAt(s.map, centre.x, centre.y);
    if (!contestantKnowledge(memory, p.keys).known(cell)) return centre;
  }
  const reach = memory ? DISCOVERY_CELL_SIZE / 2 - radius : Infinity;
  for (const { x, y } of CELL_OFFSETS) {
    if (Math.abs(x) > reach || Math.abs(y) > reach) continue;
    if (canOccupy(s.map, centre.x + x, centre.y + y, radius, !!memory)) return { x: centre.x + x, y: centre.y + y };
  }
  return centre;
}

function abandonLead(p: Player): void {
  const lead = leads.get(p);
  if (lead) lead.done = true;
}

export interface BotIntent {
  input: PlayerInput;
  /** A utility to activate after selecting input.slot, before movement. */
  utilitySlot?: number;
  /** Equipment to discard when pursuing a cell with a full inventory. */
  discardSlot?: number;
}

// Mixed temperaments create occasional betrayal, rather than every converging bot starting
// a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes,
// and under `hearingResponse` follow gunfire (#685).
export const isOpportunistic = (p: Pick<Player, 'id'>): boolean => p.id.charCodeAt(p.id.length - 1) % 3 === 0;

/** Collect equipment/utility/drop intents without applying them; private planning memory,
 * routes, sliced searches and their shared per-tick allowance may still change. */
export function collectBotIntent(s: Game, p: Player): BotIntent {
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
  }
  const effectiveInventory = () => p.inventory!.map((item, slot) => slot === spentUtility ? null : item);
  const opportunistic = isOpportunistic(p);
  start('sim.bots.sight');
  const nearest = s.players.filter(t => t.id !== p.id && (t.role !== p.role || p.aggressor === t.id && s.tick < p.aggressionUntil!
    || p.role === 'contestant' && opportunistic && s.tick > 30 * HZ && distance(p, t) < (s.tick > 120 * HZ ? 320 : 180))
    && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  stop('sim.bots.sight');
  // Under `hearingResponse` a gladiator that sees no one goes to where it heard a shot; an opportunistic
  // contestant may follow one too (#685). The lead is kept up every tick, so arrival is noticed in passing.
  const reacting = s.content.hearingResponse === 'temperament' && (p.role === 'gladiator' || opportunistic);
  const lead = reacting ? leadOf(s, p) : null;
  // Under `hunting: 'sweep'` a gladiator with no one seen and nothing heard sweeps regions ahead of the wall, and takes
  // transit toward a lead or a sweep when that is quicker (#683).
  const hunting = p.role === 'gladiator' && (s.content.hunting === 'sweep' || s.content.hunting === 'front');
  if (hunting) noteHunterTarget(s, p, !!(nearest || lead));
  const sweep = hunting && !nearest && !lead ? sweepTarget(s, p, at => standingIn(s, p, at)) : null;
  let target: Vec2 = p.role === 'gladiator' ? nearest || lead || sweep || s.map.stations.find(st => st.x > s.hazardX + 1200) || s.map.exit : s.map.exit;
  let transitTo: StationId | undefined;
  // What the bot is transiting toward while it heads for the station, if it is.
  let via: Vec2 | undefined;
  if (hunting && !nearest) {
    const plan = transitPlan(s, p, target);
    if (plan) { via = target; target = plan.from; if (p.railCd === 0 && distance(p, plan.from) < TRANSIT_REACH) transitTo = plan.to.id; }
  }
  let exploring = false;
  if (p.role === 'contestant') {
    // A contestant knows what it has discovered (15, #230). Content without discovery gives it the whole
    // map: an information rule a scenario may set.
    start('sim.bots.items');
    const memory = p.discovery, pursuit = memory ? pursuitOf(p) : null;
    const known = (feature: Vec2) => !memory || isFeatureDiscovered(memory, s.map, feature);
    // What it remembers, read by what the decision asks for (#864): the power cells, and loot near it. Without discovery it reads the whole ground.
    const remembered = memory ? rememberedItems(memory) : undefined;
    const setAside = (i: GroundItem) => !!memory && pursuit!.ignored.get(i.id)! > s.tick;
    let scanned = 0;
    const cellItems = (): GroundItem[] => {
      const listed = memory ? remembered?.cellItems() ?? [] : s.map.items;
      scanned += listed.length;
      return listed.filter(i => i.kind === 'cell' && !setAside(i));
    };
    // A door is locked when the bot last saw it locked.
    const locked = (g: Gate) => { const seen = memory?.gates?.get(g.id); return !!seen && !!seen.locked && !seen.open; };
    const buildingGates = botGates(s.map).byBuilding;
    const accessible = (i: GroundItem) => p.keys > 0 || !i.buildingId || !(buildingGates.get(i.buildingId)?.some(locked));
    const charged = !!cell && cell.charge >= s.content.cellChargeTicks;
    const objective: Vec2[] = !cell ? cellItems().filter(i => i.x > s.hazardX + 100 && accessible(i))
      : !charged ? s.map.chargers.filter(st => st.x > s.hazardX + 100 && known(st)) : [];
    if (memory && !objective.length && !(charged && known(s.map.exit))) {
      // Nothing it needs is known: search for it, and fall back on the exit only once nothing is left to search.
      stop('sim.bots.items'); start('sim.bots.explore');
      // With nothing it needs in mind, an opportunist follows gunfire before searching; the rest search away from it.
      const avoid = s.content.hearingResponse === 'temperament' && !opportunistic ? heardBy(p, s.tick) : [];
      const frontier = lead ? null : exploreTarget(s, p, memory, avoid);
      stop('sim.bots.explore'); start('sim.bots.items');
      if (lead) target = lead;
      else if (frontier) { target = frontier; exploring = true; } else if (!known(s.map.exit)) target = p;
    }
    if (objective.length) {
      // Nearest first.
      target = objective.sort((a, b) => distance(p, a) - distance(p, b))[0];
      if (!cell && effectiveInventory().every(Boolean)) {
        const discard = effectiveInventory().findIndex(item => item?.kind !== 'weapon' || item.ammo === 0 && !reloadableRounds(s, p, item));
        if (discard >= 0) intent.discardSlot = discard;
      }
    }
    const inventory = effectiveInventory().map((item, slot) => slot === intent.discardSlot ? null : item);
    // A matching weapon refills its magazine, or under L2 the family reserve it would feed.
    const room = (slot: WeaponItem) => reserveRoom(s, p, s.content.reloading!.weapons[slot.weaponType].family);
    const refills = (slot: WeaponItem) => s.content.reloading ? room(slot) > 0 : slot.ammo < s.content.weapons[slot.weaponType]?.maxAmmo;
    const full = (slot: WeaponItem) => s.content.reloading ? room(slot) <= 0 : slot.ammo >= s.content.weapons[slot.weaponType].maxAmmo;
    const lootable = memory ? remembered?.near(p, 210) ?? [] : s.map.items;
    scanned += lootable.length;
    count('work.bots.items', scanned);
    const loot = lootable.filter(i => i.kind !== 'cell' && !setAside(i) && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && accessible(i)
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
  const leg = p.role === 'gladiator' && s.content.hunterPlanning === 'portals' ? legGoal(s, p, target) : target;
  const status = repathTiles(s, p, leg);
  if (leg !== target && (status === 'no-known-route' || status === 'invalid-endpoint')) abandonLeg(p);
  if (status === 'no-known-route' || status === 'invalid-endpoint') {
    if (exploring) abandonExploration(p);
    // A station it can't reach gives up what it was transiting toward, as a goal it can't reach would.
    if (lead && (target === lead || via === lead)) abandonLead(p);
    if (sweep && (target === sweep || via === sweep)) giveUpSweep(s, p);
    // A known dead end sets the item aside, as a stall would; it is not given up for good (22.6).
    const item = target as Partial<GroundItem>, pursuit = pursuits.get(p);
    if (pursuit && item.kind && item.id) { pursuit.ignored.set(item.id, s.tick + IGNORE_FOR as Tick); clearRoute(p); }
  }
  stop('sim.bots.plan'); start('sim.bots.steer');
  let waypoint = p.route?.[0] ?? target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else { while (p.route?.length && passed(s, p, p.route[0]!, p.route[1] ?? target)) p.route.shift(); waypoint = p.route?.[0] ?? target; }
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
  start('sim.bots.dynamic');
  const next = dynamicWaypoint(s, p, { x: p.x + dx, y: p.y + dy });
  dx = next.x - p.x; dy = next.y - p.y;
  stop('sim.bots.dynamic');
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
    const held = p.inventory?.[intent.input.slot ?? -1];
    if (held?.kind === 'weapon' && reloadableRounds(s, p, held) > 0 && (held.ammo === 0 || !nearest)) intent.input.reload = true;
  }
  if (transitTo) intent.input.transit = transitTo;
  intent.input = { ...intent.input, x: dx / length, y: dy / length, aim: nearest ? atan2(nearest.y - p.y, nearest.x - p.x) : dx === 0 && dy === 0 ? p.heading : atan2(dy, dx), attack: !!nearest && !allyInLine && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || p.x < s.hazardX + 200 || gatesNear(s.map, p.x - GATE_REACH, p.y - GATE_REACH, p.x + GATE_REACH, p.y + GATE_REACH).some(g => !g.open && distance(p, g) < GATE_REACH) };
  return intent;
}
