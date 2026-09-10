import PF from 'pathfinding';
import { movePlayer, canOccupy, lineClear, TILE, VISION } from './movement.js';
import { generateMap, navigationGrid, WORLD_WIDTH, WORLD_HEIGHT } from './map.js';
import { count, start, stop } from './profiler.js';
import { POTENTIAL_RADIUS } from './view.js';
import { SLOT_COUNT, WEAPONS, equipped, collectEquipment, syncWeapon } from './equipment.js';
import { stepTraps } from './traps.js';
export { generateMap, TILE };
export const VERSION = 'last-exit-0.4';
export const HZ = 20;
export const DURATION = 600 * HZ;
export const CELL_CHARGE_TICKS = 45 * HZ;
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
    skill: input.skill === true || p.input.skill === true, interact: input.interact === true || p.input.interact === true, sneak: input.sneak === true,
    slot: Number.isInteger(input.slot) && input.slot >= 0 && input.slot < SLOT_COUNT ? input.slot : p.input.slot };
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
  if (!viewer || viewer.id === target.id || viewer.role === target.role || target.status !== 'active') return true;
  // A reveal makes a contestant visible to gladiators at any range, so it is never distance culled.
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return distance(viewer, target) < POTENTIAL;
}
// True line of sight. This stays authoritative and drives gameplay — bot targeting, ability reach,
// hit resolution — none of which may depend on anything a client says.
export function visibleTo(s, viewer, target) {
  if (!viewer || viewer.id === target.id || viewer.role === target.role || target.status !== 'active') return true;
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return !target.cloak && distance(viewer, target) < VISION && lineClear(s.map, viewer, target);
}
// What one client may learn about another player it can currently see. Everything omitted is either
// private (inventory, ability timers, whether a slot is a bot) or unread by the renderer, so it never
// leaves the server for anyone but the player it describes. Recordings keep the full state.
const OBSERVED = ['id', 'role', 'kit', 'name', 'x', 'y', 'heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'];
const observed = p => Object.fromEntries(OBSERVED.map(key => [key, p[key]]));
const privately = ({ path, input, inputTick, bot, movedThisTick, ...p }) => p;
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
function damage(s, target, amount, source) {
  if (target.status !== 'active') return;
  const blocked = Math.min(target.shield, amount);
  target.shield -= blocked; target.hp = Math.max(0, target.hp - amount + blocked);
  if (target.hp > 0) return;
  target.status = 'eliminated'; event(s, `${target.name} ${source ? 'eliminated by ' + source.name : 'lost to the arena'}`);
  if (target.cell) {
    s.map.items.push({ id: `cell-drop-${s.serial++}`, kind: 'cell', x: target.x, y: target.y, charge: target.cell.charge });
    target.cell = null; target.charging = null;
  }
  for (const item of target.inventory || []) if (item) for (let i = 0; i < (item.count || 1); i++) s.map.items.push({ ...item, id: `equipment-drop-${s.serial++}`, x: target.x, y: target.y });
  if (target.inventory) { target.inventory.fill(null); syncWeapon(target); }
  if (source?.role === 'gladiator') {
    source.kills++; source.level = Math.min(4, 1 + source.kills); source.maxHp += 20; source.hp = Math.min(source.maxHp, source.hp + 45); source.cooldown = 0; effect(s, source, 'upgrade', 90);
  }
}
function interact(s, p) {
  if (p.role === 'contestant') {
    const pickup = s.map.items.find(i => ['weapon', 'med', 'shield'].includes(i.kind) && distance(p, i) < 45 && lineClear(s.map, p, i));
    if (!p.bot && pickup && p.inventory.every(Boolean)) {
      const old = equipped(p); p.inventory[p.selectedSlot] = null;
      if (collectEquipment(p, pickup)) {
        s.map.items = s.map.items.filter(i => i.id !== pickup.id);
        for (let i = 0; i < (old.count || 1); i++) s.map.items.push({ ...old, id: `equipment-drop-${s.serial++}`, x: p.x, y: p.y });
      } else p.inventory[p.selectedSlot] = old;
      syncWeapon(p);
    }
    const gate = s.map.gates.find(g => !g.open && distance(p, g) < 85);
    if (gate && p.keys > 0) { gate.open = true; p.keys--; event(s, `${p.name} opened an access gate`); }
    if (p.cell && p.cell.charge < CELL_CHARGE_TICKS) {
      const station = s.map.chargers.find(st => distance(p, st) < 70 && lineClear(s.map, p, st));
      if (station) p.charging = station.id;
    }
    if (distance(p, s.map.exit) < 65 && s.slots > 0 && p.cell?.charge >= CELL_CHARGE_TICKS && lineClear(s.map, p, s.map.exit)) {
      s.slots--; p.cell = null; p.charging = null; p.status = 'escaped'; event(s, `${p.name} powered an escape pod. ${s.slots} slots remain`);
    }
  } else if (p.railCd === 0) {
    const i = s.map.stations.findIndex(st => distance(p, st) < 70);
    if (i >= 0) {
      const candidates = s.map.stations.filter(st => st.x > s.hazardX + TILE && st.id !== s.map.stations[i].id);
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
  if (p.inventory) {
    const utility = p.inventory.findIndex(i => i && (i.kind === 'med' && p.hp < 65 || i.kind === 'shield' && p.shield < 45));
    const weapon = p.inventory.findIndex(i => i?.kind === 'weapon');
    p.selectedSlot = utility >= 0 ? utility : weapon >= 0 ? weapon : 0; syncWeapon(p);
    if (utility >= 0) attack(s, p);
  }
  const nearest = s.players.filter(t => t.role !== p.role && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  let target = p.role === 'gladiator' ? nearest || { x: Math.max(1300, s.hazardX + 1200), y: WORLD_HEIGHT / 2 } : s.map.exit;
  if (p.role === 'contestant') {
    const objective = !p.cell ? s.map.items.filter(i => i.kind === 'cell' && i.x > s.hazardX + 100)
      : p.cell.charge < CELL_CHARGE_TICKS ? s.map.chargers.filter(st => st.x > s.hazardX + 100) : [];
    if (objective.length) target = objective.sort((a, b) => distance(p, a) - distance(p, b))[0];
    const loot = s.map.items.filter(i => i.kind !== 'cell' && i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210
      && (i.kind !== 'med' || p.hp < 75)
      && (i.kind === 'access' || p.inventory.some(slot => !slot) || p.inventory.some(slot => slot?.kind === i.kind && slot.count < 3))
      && (i.kind !== 'weapon' || !p.inventory.some(slot => slot?.weaponType === i.weaponType))).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && loot.kind !== 'cell' && !p.charging && (!nearest || distance(p, nearest) > 250)) target = loot;
  }
  if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
    start('sim.repath'); count('work.repath');
    // Follow a local window toward distant objectives. A full-height window covers all three routes
    // and checkpoint bypasses, while longitudinal chunks bound the pathfinding work.
    const direction = Math.sign(target.x - p.x);
    const localTarget = Math.abs(target.x - p.x) > 700 ? { x: p.x + direction * 680, y: WORLD_HEIGHT / 2 } : target;
    const bx = Math.max(0, Math.floor((p.x - 1000) / 400) * 10);
    const bounds = { x: bx, y: 0, width: Math.min(60, Math.ceil(s.map.width / TILE) - bx), height: Math.ceil(s.map.height / TILE) };
    const matrix = navigationGrid(s.map, p.role, bounds);
    const from = nearestNode(matrix, { x: p.x - bx * TILE, y: p.y });
    const to = nearestNode(matrix, { x: localTarget.x - bx * TILE, y: localTarget.y });
    start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
    p.path = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(from.x, from.y, to.x, to.y, grid).slice(1).map(([x, y]) => [x + bx, y]);
    stop('sim.repath');
  }
  let waypoint = p.path?.[0] ? center(...p.path[0]) : target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else if (distance(p, waypoint) < 11 && p.path?.length) { p.path.shift(); waypoint = p.path[0] ? center(...p.path[0]) : target; }
  const dx = waypoint.x - p.x, dy = waypoint.y - p.y, length = Math.max(9, Math.hypot(dx, dy));
  if (p.role === 'contestant' && p.cell?.charge < CELL_CHARGE_TICKS && s.map.chargers.some(st => distance(p, st) < 55 && lineClear(s.map, p, st))) return { x: 0, y: 0, interact: true };
  return { x: dx / length, y: dy / length, aim: nearest ? Math.atan2(nearest.y - p.y, nearest.x - p.x) : Math.atan2(dy, dx), attack: !!nearest && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || p.x < s.hazardX + 200 };
}
export function step(s) {
  if (s.phase !== 'live') return;
  start('sim.step');
  s.tick++;
  s.hazardX = Math.round(-80 + Math.max(0, s.tick - HAZARD_GRACE_TICKS) / (DURATION - HAZARD_GRACE_TICKS) * (s.map.width + 100));
  s.effects = s.effects.filter(e => --e.life > 0);
  for (const p of s.players) {
    p.movedThisTick = 0;
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
    if (input.skill) skill(s, p);
    if (input.attack) attack(s, p);
    if (input.interact) interact(s, p);
    if (p.charging) {
      const station = s.map.chargers.find(st => st.id === p.charging);
      if (!p.cell || p.cell.charge >= CELL_CHARGE_TICKS || input.x || input.y || !station || distance(p, station) >= 70 || !lineClear(s.map, p, station)) p.charging = null;
      else if (++p.cell.charge >= CELL_CHARGE_TICKS) { p.charging = null; event(s, `${p.name} charged a power cell`); effect(s, p, 'charge', 70); }
    }
    if (!p.bot) { p.input.skill = false; p.input.interact = false; delete p.input.slot; } // Latched presses are spent once.
    stop('sim.actions');
    start('sim.pickups');
    if (p.role === 'contestant') {
      s.map.items = s.map.items.filter(item => {
        if (distance(p, item) > 38 || !lineClear(s.map, p, item) || item.kind === 'cell' && p.cell) return true;
        if (item.kind === 'cell') { p.cell = { charge: item.charge || 0 }; p.path = []; }
        if (item.kind === 'access') p.keys++;
        if (['weapon', 'med', 'shield'].includes(item.kind) && !collectEquipment(p, item)) return true;
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
    if (b.life <= 0 || !canOccupy(s.map, b.x, b.y, 2) || !lineClear(s.map, previous, b)) return false;
    const target = s.players.find(p => (b.trap || p.role === 'gladiator') && p.status === 'active' && distance(p, b) < (p.role === 'gladiator' ? 26 : 15));
    if (target) { damage(s, target, b.damage, s.players.find(p => p.id === b.owner)); return false; }
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
