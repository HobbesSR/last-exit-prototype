import { canOccupy, insideMap, lineClear, reachClear, TILE } from '../movement.ts';
import { cellCenter, cellIndexAt, discoveryGrid, isFeatureDiscovered, DISCOVERY_INTERVAL } from '../discovery.ts';
import { straightenPath, blockAt, blockRoute } from '../map.ts';
import { gridRoute } from '../map/route.ts';
import { count, start, stop } from '../profiler.ts';
import { carriedCell, syncWeapon } from '../equipment.ts';
import { HZ } from './rules.ts';
import { distance, center } from './geometry.ts';
import { visibleTo } from './visibility.ts';
import { attack } from './combat.ts';
import { dropEquipment } from './loot.ts';
import type { DiscoveryMemory, GroundItem, Game, ItemId, Player, PlayerInput, Tick, TileCount, TileIndex, Vec2, World } from '../types.ts';

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
    const settled = seen.has(state.cell) || centre.x <= s.hazardX + EXPLORE_HAZARD_MARGIN;
    const inside = cellIndexAt(s.map, p.x, p.y) === state.cell;
    if (!inside) state.entered = -1; else if (state.entered < 0) state.entered = s.tick;
    const arrived = inside && s.tick - state.entered > DISCOVERY_INTERVAL;
    if (!settled && !arrived && !stalled(s, p, state, `cell:${state.cell}`, centre)) return centre;
    if (!seen.has(state.cell)) state.abandoned.add(state.cell);
    state.cell = -1;
  }
  const { cols, rows } = discoveryGrid(s.map);
  let best = -1, bestScore = Infinity;
  // Sight order is deterministic, and ties keep the first, so the choice is too.
  for (const index of seen) {
    const col = index % cols, row = (index - col) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc, r = row + dr, next = r * cols + c;
      if (c < 0 || r < 0 || c >= cols || r >= rows || seen.has(next) || state.abandoned.has(next)) continue;
      const centre = cellCenter(s.map, next);
      if (centre.x <= s.hazardX + EXPLORE_HAZARD_MARGIN || !insideMap(s.map, centre.x, centre.y)) continue;
      const score = distance(p, centre) - (centre.x - p.x) * EXPLORE_RIGHTWARD;
      if (score < bestScore) { bestScore = score; best = next; }
    }
  }
  if (best < 0) return null;
  state.cell = best; state.entered = -1;
  p.path = []; // A new destination: route to it now rather than finish the old route first.
  return cellCenter(s.map, best);
}

function abandonExploration(p: Player): void {
  const state = pursuits.get(p);
  if (state && state.cell >= 0) { state.abandoned.add(state.cell); state.cell = -1; }
}

export function botInput(s: Game, p: Player): PlayerInput {
  const cell = carriedCell(p);
  if (p.inventory) {
    const utility = p.inventory.findIndex(i => !!i && (i.kind === 'med' && p.hp < 65 || i.kind === 'shield' && p.shield < 45));
    const weapon = p.inventory.findIndex(i => i?.kind === 'weapon' && (i.ammo ?? s.content.weapons[i.weaponType].ammo) > 0);
    p.selectedSlot = utility >= 0 ? utility : weapon >= 0 ? weapon : 0; syncWeapon(p, s.content.weapons);
    if (utility >= 0) attack(s, p);
  }
  // Mixed temperaments create occasional betrayal, rather than every converging bot starting
  // a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes.
  const opportunistic = p.id.charCodeAt(p.id.length - 1) % 3 === 0;
  const nearest = s.players.filter(t => t.id !== p.id && (t.role !== p.role || p.aggressor === t.id && s.tick < p.aggressionUntil!
    || p.role === 'contestant' && opportunistic && s.tick > 30 * HZ && distance(p, t) < (s.tick > 120 * HZ ? 320 : 180))
    && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  let target: Vec2 = p.role === 'gladiator' ? nearest || s.map.stations.find(st => st.x > s.hazardX + 1200) || s.map.exit : s.map.exit;
  let exploring = false;
  if (p.role === 'contestant') {
    // A contestant knows what it has discovered (15, #230). Without discovery (content-1) it keeps the
    // whole map, which is what the frozen characterization traces recorded.
    const memory = p.discovery, pursuit = memory ? pursuitOf(p) : null;
    const known = (feature: Vec2) => !memory || isFeatureDiscovered(memory, s.map, feature);
    const items = memory ? [...memory.items?.values() ?? []].filter(i => !(pursuit!.ignored.get(i.id)! > s.tick)) : s.map.items;
    const accessible = (i: GroundItem) => p.keys > 0 || !i.buildingId || !s.map.gates.some(g => g.buildingId === i.buildingId && g.locked && !g.open);
    const charged = !!cell && cell.charge >= s.content.cellChargeTicks;
    const objective: Vec2[] = !cell ? items.filter(i => i.kind === 'cell' && i.x > s.hazardX + 100 && accessible(i))
      : !charged ? s.map.chargers.filter(st => st.x > s.hazardX + 100 && known(st)) : [];
    if (memory && !objective.length && !(charged && known(s.map.exit))) {
      // Nothing it needs is known: search for it, and fall back on the exit only once nothing is left to search.
      const frontier = exploreTarget(s, p, memory);
      if (frontier) { target = frontier; exploring = true; } else if (!known(s.map.exit)) target = p;
    }
    if (objective.length) {
      const from = blockAt(s.map, p);
      const cost = (t: Vec2) => blockRoute(s.map, from, blockAt(s.map, t)).length * 1000 + distance(p, t) * 0.05;
      target = objective.sort((a, b) => cost(a) - cost(b))[0];
      if (!cell && p.inventory!.every(Boolean)) {
        const discard = p.inventory!.findIndex(item => item?.kind !== 'weapon' || item.ammo === 0);
        if (discard >= 0) { dropEquipment(s, p, p.inventory![discard]!); p.inventory![discard] = null; }
      }
    }
    const loot = items.filter(i => i.kind !== 'cell' && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && accessible(i)
      && (i.kind !== 'med' || p.hp < 75)
      && (i.kind === 'access' || p.inventory!.some(slot => !slot) || p.inventory!.some(slot => slot?.kind === i.kind && slot.kind !== 'weapon' && slot.kind !== 'cell' && slot.count < 3
        || slot?.kind === 'weapon' && slot.weaponType === i.weaponType && slot.ammo < s.content.weapons[i.weaponType!]?.maxAmmo))
      && (i.kind !== 'weapon' || i.ammo !== 0 && !p.inventory!.some(slot => slot?.kind === 'weapon' && slot.weaponType === i.weaponType && slot.ammo >= s.content.weapons[i.weaponType!].maxAmmo))).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && loot.kind !== 'cell' && !p.charging && (!nearest || distance(p, nearest) > 250)) { target = loot; exploring = false; }
    if (pursuit && !exploring) {
      pursuit.cell = -1;
      const item = target as Partial<GroundItem>;
      if (item.kind && item.id && stalled(s, p, pursuit, item.id, target)) { pursuit.ignored.set(item.id, s.tick + IGNORE_FOR as Tick); p.path = []; }
      else if (!item.kind) pursuit.goal = '';
    }
  }
  if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
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
  let waypoint = p.path?.[0] ? center(...p.path[0]) : target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else if (distance(p, waypoint) < 11 && p.path?.length) { p.path.shift(); waypoint = p.path[0] ? center(...p.path[0]) : target; }
  let dx = waypoint.x - p.x, dy = waypoint.y - p.y;
  const hunter = p.role === 'contestant' && s.players.find(t => t.role === 'gladiator' && t.status === 'active' && distance(p, t) < 170 && visibleTo(s, p, t));
  if (hunter) {
    // Keep firing, but do not blindly follow an objective path straight into melee range.
    const away = Math.atan2(p.y - hunter.y, p.x - hunter.x);
    const goalLength = Math.max(1, Math.hypot(dx, dy));
    const options = [0, -0.5, 0.5, -1, 1, -1.5, 1.5].map(offset => {
      const x = Math.cos(away + offset), y = Math.sin(away + offset);
      const point = { x: p.x + x * 90, y: p.y + y * 90 };
      return { x, y, point, score: distance(point, hunter) + (x * dx + y * dy) / goalLength * 15 - (point.x < s.hazardX + 100 ? 1000 : 0) };
    }).filter(o => canOccupy(s.map, o.point.x, o.point.y, 12) && reachClear(s.map, p, o.point)).sort((a, b) => b.score - a.score);
    if (options.length) { dx = options[0].x * 9; dy = options[0].y * 9; }
  }
  const length = Math.max(9, Math.hypot(dx, dy));
  if (p.role === 'contestant' && cell != null && cell.charge < s.content.cellChargeTicks && s.map.chargers.some(st => distance(p, st) < 55 && lineClear(s.map, p, st))) return { x: 0, y: 0, interact: true };
  const allyInLine = p.role === 'contestant' && nearest && s.players.some(other => {
    if (other.id === p.id || other.id === nearest.id || other.role !== 'contestant' || other.status !== 'active') return false;
    const nx = nearest.x - p.x, ny = nearest.y - p.y, projection = ((other.x - p.x) * nx + (other.y - p.y) * ny) / (nx * nx + ny * ny);
    return projection > 0 && projection < 1 && Math.hypot(other.x - p.x - projection * nx, other.y - p.y - projection * ny) < 28;
  });
  return { x: dx / length, y: dy / length, aim: nearest ? Math.atan2(nearest.y - p.y, nearest.x - p.x) : Math.atan2(dy, dx), attack: !!nearest && !allyInLine && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || s.map.gates.some(g => !g.open && distance(p, g) < 85) || p.x < s.hazardX + 200 };
}
