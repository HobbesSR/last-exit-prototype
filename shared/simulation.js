import PF from 'pathfinding';
import { movePlayer, canOccupy, lineClear, reachClear, gateShape, TILE, VISION } from './movement.js';
import { generateMap, navigationGrid, blockAt, blockRoute, WORLD_WIDTH, WORLD_HEIGHT } from './map.js';
import { count, start, stop } from './profiler.js';
import { POTENTIAL_RADIUS, roofConceals } from './view.js';
import { SLOT_COUNT, WEAPONS, equipped, carriedCell, collectEquipment, syncWeapon, rearrangeEquipment } from './equipment.js';
import { stepTraps } from './traps.js';
export { generateMap, TILE };
export const VERSION = 'last-exit-0.6';
export const HZ = 20;
export const DURATION = 600 * HZ;
export const CELL_CHARGE_TICKS = 5 * HZ;
export const GLADIATOR_RESPAWN_TICKS = 20 * HZ;
export const HAZARD_GRACE_TICKS = 60 * HZ;
export const KITS = {
  warden: { name: 'Warden', color: 0xff6b70, damage: 24, cooldown: 110, skill: 'Shockwave' },
  specter: { name: 'Specter', color: 0xb39aff, damage: 19, cooldown: 150, skill: 'Pulse scan' },
  striker: { name: 'Striker', color: 0xffba62, damage: 29, cooldown: 95, skill: 'Overdrive' },
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const tile = p => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });
const center = (x, y) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
export function createGame(seed = 4217) {
  const map = generateMap(seed);
  const s = { version: VERSION, seed, rng: seed || 1, tick: 0, phase: 'live', map, players: [], projectiles: [], effects: [], events: [], slots: 3, hazardX: -80, serial: 0 };
  for (const [i, name] of ['Mica', 'Juno', 'Patch', 'Pip', 'Nova', 'Rook', 'Echo', 'Sol'].entries()) s.players.push(makePlayer(`c${i}`, name, 'contestant', 'warden', i));
  s.players.push(makePlayer('g0', 'IRONCLAD', 'gladiator', 'warden', 0), makePlayer('g1', 'VESPER', 'gladiator', 'specter', 1));
  for (const p of s.players) if (p.role === 'contestant') { p.inventory = Array(SLOT_COUNT).fill(null); p.selectedSlot = 0; }
  s.players.filter(p => p.role === 'contestant').forEach((p, i) => Object.assign(p, map.spawns[i]));
  s.players.filter(p => p.role === 'gladiator').forEach((p, i) => {
    const station = map.stations.at(-1 - i) || map.exit; p.x = station.x; p.y = station.y;
  });
  return s;
}
function makePlayer(id, name, role, kit, index) {
  return { id, name, role, kit, bot: true, x: role === 'contestant' ? 1500 + index * 33 : WORLD_WIDTH - 1700 - index * 130, y: WORLD_HEIGHT / 2 + (role === 'contestant' ? (index % 3 - 1) * 25 : 0), hp: role === 'contestant' ? 100 : 360, maxHp: role === 'contestant' ? 100 : 360, shield: 0, keys: 0, weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0, input: {}, lastSeq: -1 };
}
export function joinGame(s, id, role = 'contestant', kit = 'warden', name = 'You') {
  if (s.phase !== 'live') return null;
  const p = s.players.find(p => p.bot && p.role === role && p.status === 'active');
  if (!p) return null;
  p.id = id; p.name = name.slice(0, 16); p.bot = false;
  if (Object.hasOwn(KITS, kit)) p.kit = kit;
  p.input = {}; p.lastSeq = -1; p.path = [];
  return p;
}
export function setInput(s, id, input) {
  const p = s.players.find(p => p.id === id);
  if (!p || !input || !Number.isSafeInteger(input.seq) || input.seq <= p.lastSeq) return false;
  const axis = v => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  p.lastSeq = input.seq;
  // Axes and held buttons are replaced, but one-shot presses are latched. Clients send on their own
  // interval, so two messages can arrive between two ticks, and the second must not erase a button
  // press the first one carried before any tick had a chance to read it.
  p.input = { x: axis(input.x), y: axis(input.y), aim: Number.isFinite(input.aim) ? input.aim : 0, attack: input.attack === true,
    skill: input.skill === true || p.input.skill === true, interact: input.interact === true || p.input.interact === true, drop: input.drop === true || p.input.drop === true, sneak: input.sneak === true,
    slot: Number.isInteger(input.slot) && input.slot >= 0 && input.slot < SLOT_COUNT ? input.slot : p.input.slot,
    moveSlot: input.moveSlot && Number.isInteger(input.moveSlot.from) && Number.isInteger(input.moveSlot.to)
      && input.moveSlot.from >= 0 && input.moveSlot.from < SLOT_COUNT && input.moveSlot.to >= 0 && input.moveSlot.to < SLOT_COUNT
      ? { from: input.moveSlot.from, to: input.moveSlot.to } : p.input.moveSlot };
  p.inputTick = s.tick; return true;
}
// The reach the server transmits within. Generous on purpose: it carries everything that could become
// visible before the next update — through cover clearing, a cloak dropping, a scan reveal, or simply
// movement — so the client never has to wait on the server to show something that just became
// observable. The client resolves what is actually seen. The trade is explicit: this radius is also
// what a modified client could see through walls.
export const POTENTIAL = POTENTIAL_RADIUS;
// What the server will send, as opposed to what the viewer can actually see.
export function couldSee(s, viewer, target) {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  // A reveal makes a contestant visible to gladiators at any range, so it is never distance culled.
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return distance(viewer, target) < POTENTIAL;
}
// True line of sight. This stays authoritative and drives gameplay — bot targeting, ability reach,
// hit resolution — none of which may depend on anything a client says.
export function visibleTo(s, viewer, target) {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return !target.cloak && !roofConceals(s.map, viewer, target) && distance(viewer, target) < VISION && lineClear(s.map, viewer, target);
}
// What one client may learn about another player it can currently see. Everything omitted is either
// private (inventory, ability timers, whether a slot is a bot) or unread by the renderer, so it never
// leaves the server for anyone but the player it describes. Recordings keep the full state.
const OBSERVED = ['id', 'role', 'kit', 'name', 'x', 'y', 'heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'];
const observed = p => Object.fromEntries(OBSERVED.map(key => [key, p[key]]));
const privately = ({ path, input, inputTick, bot, movedThisTick, aggressor, aggressionUntil, ...p }) => p;
export function playerView(s, frame, id) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s, frame, id) {
  const viewer = frame.players.find(p => p.id === id);
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = p => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const { rng, serial, ...rest } = frame; // Replay bookkeeping; no client reads either.
  return { ...rest, duration: DURATION, directed: !viewer, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    players: frame.players.filter(p => couldSee(s, viewer, p)).map(p => p.id === id ? privately(p) : observed(p)),
    items: frame.items.filter(inRange), traps: (frame.traps || []).filter(inRange).map(({ targetId, ...trap }) => trap), projectiles: frame.projectiles.filter(inRange), effects: frame.effects.filter(inRange) };
}
function event(s, text) { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
function effect(s, p, kind, radius = 60) { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
function dropEquipment(s, p, item) {
  for (let i = 0; i < (item.count || 1); i++) {
    let point = p;
    for (let j = 0; j < 180; j++) {
      const angle = (s.serial + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      const candidate = { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
      if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, p, candidate) && s.map.items.every(other => distance(other, candidate) > 32)) { point = candidate; break; }
    }
    s.map.items.push({ ...item, count: 1, id: `equipment-drop-${s.serial++}`, x: point.x, y: point.y, droppedBy: p.id, pickupAfter: s.tick + HZ });
  }
}
function damage(s, target, amount, source) {
  if (target.status !== 'active') return;
  const blocked = Math.min(target.shield, amount);
  target.shield -= blocked; target.hp = Math.max(0, target.hp - amount + blocked);
  if (source && source.id !== target.id) { target.aggressor = source.id; target.aggressionUntil = s.tick + 10 * HZ; }
  if (target.hp > 0) return;
  target.status = 'eliminated'; event(s, `${target.name} ${source ? 'eliminated by ' + source.name : 'lost to the arena'}`);
  target.charging = null;
  if (target.role === 'gladiator') { target.status = 'respawning'; target.respawnAt = s.tick + GLADIATOR_RESPAWN_TICKS; target.input = {}; }
  for (const item of target.inventory || []) if (item) dropEquipment(s, target, item);
  if (target.inventory) { target.inventory.fill(null); syncWeapon(target); }
  if (source?.role === 'gladiator') {
    source.kills++; source.level = Math.min(4, 1 + source.kills); source.maxHp += 20; source.hp = Math.min(source.maxHp, source.hp + 45); source.cooldown = 0; effect(s, source, 'upgrade', 90);
  }
  else if (source?.role === 'contestant') source.kills++;
}
function interact(s, p) {
  const cell = carriedCell(p);
  const charged = p.inventory?.find(item => item?.kind === 'cell' && item.charge >= CELL_CHARGE_TICKS);
  if (p.role === 'contestant' && distance(p, s.map.exit) < 65 && s.slots > 0 && charged && lineClear(s.map, p, s.map.exit)) {
    s.slots--; p.inventory[p.inventory.indexOf(charged)] = null; syncWeapon(p); p.charging = null; p.status = 'escaped';
    event(s, p.name + ' powered an escape pod. ' + s.slots + ' slots remain'); return;
  }
  if (cell && cell.charge < CELL_CHARGE_TICKS) {
    const station = s.map.chargers.find(st => distance(p, st) < 70 && lineClear(s.map, p, st));
    if (station) { p.charging = station.id; return; }
  }
  const pickup = p.inventory && s.map.items.filter(i => ['weapon', 'med', 'shield', 'cell'].includes(i.kind) && distance(p, i) < 45 && reachClear(s.map, p, i)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (!p.bot && pickup && p.inventory.every(Boolean)) {
    const index = p.selectedSlot, old = equipped(p); p.inventory[index] = null;
    if (collectEquipment(p, pickup)) { s.map.items = s.map.items.filter(i => i.id !== pickup.id); dropEquipment(s, p, old); }
    else p.inventory[index] = old;
    syncWeapon(p); return;
  }
  const gate = s.map.gates.filter(g => distance(p, g) < 85 && (!p.bot || !g.open) && lineClear(s.map, p, g, g.id)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (gate) {
    const locked = gate.locked ?? gate.kind !== 'door';
    if (!gate.open && (!locked || p.keys > 0)) {
      gate.open = true; if (locked) { p.keys--; gate.locked = false; } p.path = [];
    } else if (gate.open && gate.kind === 'door' && !p.bot) {
      const box = gateShape(gate);
      const occupied = s.players.some(other => other.status === 'active' && Math.hypot(other.x - Math.max(box.x, Math.min(box.x + box.w, other.x)), other.y - Math.max(box.y, Math.min(box.y + box.h, other.y))) < (other.role === 'gladiator' ? 23 : 12));
      if (!occupied) { gate.open = false; p.path = []; }
    }
    return;
  }
  if (p.role === 'gladiator' && p.railCd === 0) {
    const station = s.map.stations.find(st => distance(p, st) < 70);
    if (station) {
      const candidates = s.map.stations.filter(st => st.x > s.hazardX + TILE && st.id !== station.id);
      const next = candidates.find(st => st.x > p.x + TILE) || candidates[0];
      if (next) { effect(s, p, 'rail', 60); p.x = next.x; p.y = next.y; p.path = []; p.railCd = 180; effect(s, p, 'rail', 60); }
    }
  }
}
function skill(s, p) {
  if (p.cooldown > 0) return;
  if (p.role === 'contestant') return;
  p.cooldown = Math.max(45, KITS[p.kit].cooldown - (p.level - 1) * 12);
  if (p.kit === 'warden') {
    effect(s, p, 'shock', 130);
    for (const t of s.players) if (t.role !== p.role && t.status === 'active' && distance(p, t) < 130 && lineClear(s.map, p, t)) { damage(s, t, 18 + 5 * p.level, p); t.stun = 22; }
  } else if (p.kit === 'specter') {
    effect(s, p, 'scan', 450);
    for (const t of s.players) if (t.role !== p.role && distance(p, t) < 450) t.revealed = 110;
  } else { p.boost = 55; effect(s, p, 'upgrade', 75); }
}
function attack(s, p) {
  if (p.attackCd > 0) return;
  if (p.role === 'gladiator') {
    p.attackCd = 13; effect(s, { x: p.x + Math.cos(p.heading) * 30, y: p.y + Math.sin(p.heading) * 30 }, 'slash', 55);
    const t = s.players.filter(t => t.role !== p.role && t.status === 'active' && distance(p, t) < 86 && Math.cos(Math.atan2(t.y - p.y, t.x - p.x) - p.heading) > 0.25 && lineClear(s.map, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (t) damage(s, t, KITS[p.kit].damage + (p.level - 1) * 4, p);
  } else {
    const item = equipped(p);
    if (!item) return;
    if (item.kind === 'med' || item.kind === 'shield') {
      if (item.kind === 'med' && p.hp >= p.maxHp || item.kind === 'shield' && p.shield >= 75) return;
      if (item.kind === 'med') p.hp = Math.min(p.maxHp, p.hp + 40);
      else p.shield = Math.min(75, p.shield + 30);
      if (--item.count <= 0) p.inventory[p.selectedSlot] = null;
      p.attackCd = HZ; syncWeapon(p); effect(s, p, 'loot', 30); return;
    }
    const weapon = WEAPONS[item.weaponType]; if (!weapon) return;
    item.ammo ??= weapon.ammo;
    if (item.ammo <= 0) return;
    item.ammo--;
    p.attackCd = weapon.cooldown;
    for (const spread of weapon.spread) s.projectiles.push({ id: s.serial++, owner: p.id, x: p.x, y: p.y, dx: Math.cos(p.heading + spread) * weapon.speed, dy: Math.sin(p.heading + spread) * weapon.speed, life: weapon.life, damage: weapon.damage }); p.cloak = 0;
  }
}
function nearestNode(matrix, point) {
  const t = tile(point);
  for (let r = 0; r < 5; r++) for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) if (matrix[y]?.[x] === 0) return { x, y };
  return t;
}
function botInput(s, p) {
  const cell = carriedCell(p);
  if (p.inventory) {
    const utility = p.inventory.findIndex(i => i && (i.kind === 'med' && p.hp < 65 || i.kind === 'shield' && p.shield < 45));
    const weapon = p.inventory.findIndex(i => i?.kind === 'weapon' && (i.ammo ?? WEAPONS[i.weaponType].ammo) > 0);
    p.selectedSlot = utility >= 0 ? utility : weapon >= 0 ? weapon : 0; syncWeapon(p);
    if (utility >= 0) attack(s, p);
  }
  // Mixed temperaments create occasional betrayal, rather than every converging bot starting
  // a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes.
  const opportunistic = p.id.charCodeAt(p.id.length - 1) % 3 === 0;
  const nearest = s.players.filter(t => t.id !== p.id && (t.role !== p.role || p.aggressor === t.id && s.tick < p.aggressionUntil
    || p.role === 'contestant' && opportunistic && s.tick > 30 * HZ && distance(p, t) < (s.tick > 120 * HZ ? 320 : 180))
    && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  let target = p.role === 'gladiator' ? nearest || s.map.stations.find(st => st.x > s.hazardX + 1200) || s.map.exit : s.map.exit;
  if (p.role === 'contestant') {
    const accessible = i => p.keys > 0 || !i.buildingId || !s.map.gates.some(g => g.buildingId === i.buildingId && g.locked && !g.open);
    const objective = !cell ? s.map.items.filter(i => i.kind === 'cell' && i.x > s.hazardX + 100 && accessible(i))
      : cell.charge < CELL_CHARGE_TICKS ? s.map.chargers.filter(st => st.x > s.hazardX + 100) : [];
    if (objective.length) {
      const from = blockAt(s.map, p);
      const cost = t => blockRoute(s.map, from, blockAt(s.map, t)).length * 1000 + distance(p, t) * 0.05;
      target = objective.sort((a, b) => cost(a) - cost(b))[0];
      if (!cell && p.inventory.every(Boolean)) {
        const discard = p.inventory.findIndex(item => item.kind !== 'weapon' || item.ammo === 0);
        if (discard >= 0) { dropEquipment(s, p, p.inventory[discard]); p.inventory[discard] = null; }
      }
    }
    const loot = s.map.items.filter(i => i.kind !== 'cell' && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && accessible(i)
      && (i.kind !== 'med' || p.hp < 75)
      && (i.kind === 'access' || p.inventory.some(slot => !slot) || p.inventory.some(slot => slot?.kind === i.kind && (slot.count < 3 || slot.weaponType === i.weaponType && slot.ammo < WEAPONS[i.weaponType]?.maxAmmo)))
      && (i.kind !== 'weapon' || i.ammo !== 0 && !p.inventory.some(slot => slot?.weaponType === i.weaponType && slot.ammo >= WEAPONS[i.weaponType].maxAmmo))).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && loot.kind !== 'cell' && !p.charging && (!nearest || distance(p, nearest) > 250)) target = loot;
  }
  if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
    start('sim.repath'); count('work.repath');
    // The coarse street graph supplies the next block; local collision-aware A* handles its passage.
    const route = blockRoute(s.map, blockAt(s.map, p), blockAt(s.map, target));
    const localTarget = route.length > 1 ? route[1] : target;
    const bx = Math.max(0, Math.floor((Math.min(p.x, localTarget.x) - 600) / TILE));
    const by = Math.max(0, Math.floor((Math.min(p.y, localTarget.y) - 600) / TILE));
    const bounds = { x: bx, y: by, width: Math.min(Math.ceil((Math.max(p.x, localTarget.x) + 600) / TILE), Math.ceil(s.map.width / TILE)) - bx, height: Math.min(Math.ceil((Math.max(p.y, localTarget.y) + 600) / TILE), Math.ceil(s.map.height / TILE)) - by };
    const matrix = navigationGrid(s.map, p.role, bounds, p.keys > 0 ? 'all' : true);
    const from = nearestNode(matrix, { x: p.x - bx * TILE, y: p.y - by * TILE });
    const to = nearestNode(matrix, { x: localTarget.x - bx * TILE, y: localTarget.y - by * TILE });
    start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
    p.path = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(from.x, from.y, to.x, to.y, grid).slice(1).map(([x, y]) => [x + bx, y + by]);
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
  if (p.role === 'contestant' && cell?.charge < CELL_CHARGE_TICKS && s.map.chargers.some(st => distance(p, st) < 55 && lineClear(s.map, p, st))) return { x: 0, y: 0, interact: true };
  const allyInLine = p.role === 'contestant' && nearest && s.players.some(other => {
    if (other.id === p.id || other.id === nearest.id || other.role !== 'contestant' || other.status !== 'active') return false;
    const nx = nearest.x - p.x, ny = nearest.y - p.y, projection = ((other.x - p.x) * nx + (other.y - p.y) * ny) / (nx * nx + ny * ny);
    return projection > 0 && projection < 1 && Math.hypot(other.x - p.x - projection * nx, other.y - p.y - projection * ny) < 28;
  });
  return { x: dx / length, y: dy / length, aim: nearest ? Math.atan2(nearest.y - p.y, nearest.x - p.x) : Math.atan2(dy, dx), attack: !!nearest && !allyInLine && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || s.map.gates.some(g => !g.open && distance(p, g) < 85) || p.x < s.hazardX + 200 };
}
export function step(s) {
  if (s.phase !== 'live') return;
  start('sim.step');
  s.tick++;
  s.hazardX = Math.round(-80 + Math.max(0, s.tick - HAZARD_GRACE_TICKS) / (DURATION - HAZARD_GRACE_TICKS) * (s.map.width + 100));
  s.effects = s.effects.filter(e => --e.life > 0);
  for (const p of s.players) {
    p.movedThisTick = 0;
    if (p.status === 'respawning' && s.tick >= p.respawnAt) {
      const candidates = s.map.stations.filter(st => st.x > s.hazardX + 400 && canOccupy(s.map, st.x, st.y, 25)
        && s.players.every(other => other.role !== 'contestant' || other.status !== 'active' || distance(other, st) > 1000));
      const station = candidates.sort((a, b) => a.x - b.x)[0];
      if (station) { p.x = station.x; p.y = station.y; p.hp = p.maxHp; p.shield = 0; p.status = 'active'; p.respawnAt = null; p.input = {}; p.inputTick = s.tick; p.path = []; p.cooldown = 0; p.attackCd = 0; p.stun = 0; p.boost = 0; p.railCd = 0; event(s, `${p.name} returned to the hunt`); }
    }
    if (p.status !== 'active') continue;
    for (const key of ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun']) p[key] = Math.max(0, p[key] - 1);
    if (p.bot) start('sim.bots');
    const input = p.bot ? botInput(s, p) : s.tick - (p.inputTick ?? 0) > 10 ? {} : p.input;
    if (p.bot) stop('sim.bots');
    start('sim.move');
    const previousPosition = { x: p.x, y: p.y };
    p.heading = input.aim || 0; movePlayer(s.map, p, input); p.movedThisTick = distance(p, previousPosition);
    stop('sim.move');
    start('sim.actions');
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p); }
    if (input.moveSlot) rearrangeEquipment(p, input.moveSlot.from, input.moveSlot.to);
    if (input.drop && equipped(p)) { dropEquipment(s, p, equipped(p)); p.inventory[p.selectedSlot] = null; p.charging = null; syncWeapon(p); }
    if (input.skill) skill(s, p);
    if (input.attack) attack(s, p);
    if (input.interact) interact(s, p);
    if (p.charging) {
      const cell = carriedCell(p);
      const station = s.map.chargers.find(st => st.id === p.charging);
      if (!cell || cell.charge >= CELL_CHARGE_TICKS || input.x || input.y || !station || distance(p, station) >= 70 || !lineClear(s.map, p, station)) p.charging = null;
      else if (++cell.charge >= CELL_CHARGE_TICKS) { p.charging = null; event(s, `${p.name} charged a power cell`); effect(s, p, 'charge', 70); }
    }
    if (!p.bot) { p.input.skill = false; p.input.interact = false; p.input.drop = false; delete p.input.slot; delete p.input.moveSlot; } // Latched presses are spent once.
    stop('sim.actions');
    start('sim.pickups');
    if (p.role === 'contestant') {
      s.map.items = s.map.items.filter(item => {
        if (distance(p, item) > 38 || !reachClear(s.map, p, item) || item.droppedBy === p.id && item.pickupAfter > s.tick || p.bot && item.kind === 'cell' && carriedCell(p)) return true;
        if (item.kind === 'access') p.keys++;
        if (['weapon', 'med', 'shield', 'cell'].includes(item.kind) && !collectEquipment(p, item)) return true;
        if (item.kind === 'cell') p.path = [];
        effect(s, p, 'loot', 30); return false;
      });
      if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
    }
    stop('sim.pickups');
    if (p.status !== 'active') continue;
    if (p.x < s.hazardX && s.tick % 5 === 0) damage(s, p, 9, null);
    if (s.tick % 12 === 0 && s.map.hazards.some(h => p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h)) damage(s, p, 5, null);
  }
  stepTraps(s, damage, effect);
  start('sim.projectiles');
  s.projectiles = s.projectiles.filter(b => {
    const previous = { x: b.x, y: b.y }; b.x += b.dx; b.y += b.dy; b.life--;
    if (b.life <= 0) return false;
    const lengthSquared = b.dx * b.dx + b.dy * b.dy;
    const hits = s.players.filter(p => p.id !== b.owner && p.status === 'active').map(p => {
      const t = Math.max(0, Math.min(1, ((p.x - previous.x) * b.dx + (p.y - previous.y) * b.dy) / lengthSquared));
      const point = { x: previous.x + b.dx * t, y: previous.y + b.dy * t };
      return { p, t, point, hit: distance(p, point) < (p.role === 'gladiator' ? 26 : 15) };
    }).filter(h => h.hit).sort((a, b) => a.t - b.t);
    if (hits.length && lineClear(s.map, previous, hits[0].point)) { damage(s, hits[0].p, b.damage, s.players.find(p => p.id === b.owner)); return false; }
    if (!canOccupy(s.map, b.x, b.y, 2, false, true) || !lineClear(s.map, previous, b)) return false;
    return true;
  });
  stop('sim.projectiles');
  if (s.slots === 0 || !s.players.some(p => p.role === 'contestant' && p.status === 'active') || s.tick >= DURATION) {
    s.phase = 'finished'; for (const p of s.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded'; event(s, 'Broadcast complete');
  }
  stop('sim.step');
}
export function snapshot(s) {
  start('sim.snapshot');
  try { return structuredClone({ version: s.version, duration: DURATION, cellChargeTicks: CELL_CHARGE_TICKS, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: s.map.items, gates: s.map.gates, traps: s.map.traps, projectiles: s.projectiles, effects: s.effects, events: s.events }); }
  finally { stop('sim.snapshot'); }
}
