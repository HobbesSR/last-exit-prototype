import PF from 'pathfinding';
import { movePlayer, canOccupy, lineClear, TILE, VISION } from './movement.js';
import { generateMap, navigationGrid, WORLD_WIDTH, WORLD_HEIGHT } from './map.js';
import { count, start, stop } from './profiler.js';
export { generateMap, TILE };
export const VERSION = 'last-exit-0.3';
export const HZ = 20;
export const DURATION = 120 * HZ;
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
  return s;
}
function makePlayer(id, name, role, kit, index) {
  return { id, name, role, kit, bot: true, x: role === 'contestant' ? 240 + index * 33 : WORLD_WIDTH - 380 - index * 130, y: WORLD_HEIGHT / 2 + (role === 'contestant' ? (index % 3 - 1) * 25 : 0), hp: role === 'contestant' ? 100 : 360, maxHp: role === 'contestant' ? 100 : 360, shield: 0, keys: 0, weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0, input: {}, lastSeq: -1 };
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
    skill: input.skill === true || p.input.skill === true, interact: input.interact === true || p.input.interact === true, sneak: input.sneak === true };
  p.inputTick = s.tick; return true;
}
// The reach the server transmits within. Generous on purpose: it carries everything that could become
// visible before the next update — through cover clearing, a cloak dropping, a scan reveal, or simply
// movement — so the client never has to wait on the server to show something that just became
// observable. The client resolves what is actually seen. The trade is explicit: this radius is also
// what a modified client could see through walls.
export const POTENTIAL = Math.round(VISION * 1.5);
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
const privately = ({ path, input, inputTick, bot, ...p }) => p;
export function playerView(s, frame, id) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s, frame, id) {
  const viewer = s.players.find(p => p.id === id);
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = p => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const { rng, serial, ...rest } = frame; // Replay bookkeeping; no client reads either.
  return { ...rest, duration: DURATION, directed: !viewer, contestantsActive: s.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    players: frame.players.filter(p => couldSee(s, viewer, p)).map(p => p.id === id ? privately(p) : observed(p)),
    items: frame.items.filter(inRange), projectiles: frame.projectiles.filter(inRange), effects: frame.effects.filter(inRange) };
}
function event(s, text) { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
function effect(s, p, kind, radius = 60) { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
function damage(s, target, amount, source) {
  if (target.status !== 'active') return;
  const blocked = Math.min(target.shield, amount);
  target.shield -= blocked; target.hp = Math.max(0, target.hp - amount + blocked);
  if (target.hp > 0) return;
  target.status = 'eliminated'; event(s, `${target.name} ${source ? 'eliminated by ' + source.name : 'lost to the arena'}`);
  if (source?.role === 'gladiator') {
    source.kills++; source.level = Math.min(4, 1 + source.kills); source.maxHp += 20; source.hp = Math.min(source.maxHp, source.hp + 45); source.cooldown = 0; effect(s, source, 'upgrade', 90);
  }
}
function interact(s, p) {
  if (p.role === 'contestant') {
    const gate = s.map.gates.find(g => !g.open && distance(p, g) < 85);
    if (gate && p.keys > 0) { gate.open = true; p.keys--; event(s, `${p.name} opened an access gate`); }
    if (distance(p, s.map.exit) < 65 && s.slots > 0) { s.slots--; p.status = 'escaped'; event(s, `${p.name} escaped. ${s.slots} slots remain`); }
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
  if (p.role === 'contestant') { p.cloak = 55; p.boost = 28; p.cooldown = 200; effect(s, p, 'smoke', 100); return; }
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
  } else if (p.weapon > 0) {
    p.attackCd = 7;
    s.projectiles.push({ id: s.serial++, owner: p.id, x: p.x, y: p.y, dx: Math.cos(p.heading) * 35, dy: Math.sin(p.heading) * 35, life: 24, damage: 5 + p.weapon * 2 }); p.cloak = 0;
  }
}
function nearestNode(matrix, point) {
  const t = tile(point);
  for (let r = 0; r < 5; r++) for (let y = t.y - r; y <= t.y + r; y++) for (let x = t.x - r; x <= t.x + r; x++) if (matrix[y]?.[x] === 0) return { x, y };
  return t;
}
function botInput(s, p) {
  const nearest = s.players.filter(t => t.role !== p.role && t.status === 'active' && visibleTo(s, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  let target = p.role === 'gladiator' ? nearest || { x: Math.max(1300, s.hazardX + 1200), y: WORLD_HEIGHT / 2 } : s.map.exit;
  if (p.role === 'contestant') {
    const loot = s.map.items.filter(i => i.x > s.hazardX + 100 && i.x >= p.x - 60 && distance(p, i) < 210 && (i.kind !== 'med' || p.hp < 75)).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (loot && (!nearest || distance(p, nearest) > 250)) target = loot;
  }
  if (!p.path?.length || s.tick % 20 === p.name.length % 20) {
    start('sim.repath'); count('work.repath');
    const matrix = navigationGrid(s.map, p.role), from = nearestNode(matrix, p), to = nearestNode(matrix, target);
    start('sim.repathGrid'); const grid = new PF.Grid(matrix); stop('sim.repathGrid');
    p.path = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(from.x, from.y, to.x, to.y, grid).slice(1);
    stop('sim.repath');
  }
  let waypoint = p.path?.[0] ? center(...p.path[0]) : target;
  if (distance(p, target) < 55 && lineClear(s.map, p, target)) waypoint = target;
  else if (distance(p, waypoint) < 11 && p.path?.length) { p.path.shift(); waypoint = p.path[0] ? center(...p.path[0]) : target; }
  const dx = waypoint.x - p.x, dy = waypoint.y - p.y, length = Math.max(9, Math.hypot(dx, dy));
  return { x: dx / length, y: dy / length, aim: nearest ? Math.atan2(nearest.y - p.y, nearest.x - p.x) : Math.atan2(dy, dx), attack: !!nearest && distance(p, nearest) < (p.role === 'gladiator' ? 86 : 450) && lineClear(s.map, p, nearest), skill: !!nearest && distance(p, nearest) < (p.kit === 'specter' && p.role === 'gladiator' ? 320 : 125), interact: p.role === 'contestant' || p.x < s.hazardX + 200 };
}
export function step(s) {
  if (s.phase !== 'live') return;
  start('sim.step');
  s.tick++;
  s.hazardX = Math.round(-80 + Math.max(0, s.tick - 100) / (DURATION - 100) * (s.map.width + 100));
  s.effects = s.effects.filter(e => --e.life > 0);
  for (const p of s.players) {
    if (p.status !== 'active') continue;
    for (const key of ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun']) p[key] = Math.max(0, p[key] - 1);
    if (p.bot) start('sim.bots');
    const input = p.bot ? botInput(s, p) : s.tick - (p.inputTick ?? 0) > 10 ? {} : p.input;
    if (p.bot) stop('sim.bots');
    start('sim.move');
    p.heading = input.aim || 0; movePlayer(s.map, p, input);
    stop('sim.move');
    start('sim.actions');
    if (input.skill) skill(s, p);
    if (input.attack) attack(s, p);
    if (input.interact) interact(s, p);
    if (!p.bot) { p.input.skill = false; p.input.interact = false; } // Latched presses are spent once.
    stop('sim.actions');
    start('sim.pickups');
    if (p.role === 'contestant') {
      s.map.items = s.map.items.filter(item => {
        if (distance(p, item) > 38) return true;
        if (item.kind === 'access') p.keys++;
        if (item.kind === 'weapon') p.weapon = Math.min(3, p.weapon + 1);
        if (item.kind === 'med') p.hp = Math.min(p.maxHp, p.hp + 40);
        if (item.kind === 'shield') p.shield = Math.min(75, p.shield + 30);
        effect(s, p, 'loot', 30); return false;
      });
      if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
    }
    stop('sim.pickups');
    if (p.status !== 'active') continue;
    if (p.x < s.hazardX && s.tick % 5 === 0) damage(s, p, 9, null);
    if (s.tick % 12 === 0 && s.map.hazards.some(h => p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h)) damage(s, p, 5, null);
  }
  start('sim.projectiles');
  s.projectiles = s.projectiles.filter(b => {
    const previous = { x: b.x, y: b.y }; b.x += b.dx; b.y += b.dy; b.life--;
    if (b.life <= 0 || !canOccupy(s.map, b.x, b.y, 2) || !lineClear(s.map, previous, b)) return false;
    const target = s.players.find(p => p.role === 'gladiator' && p.status === 'active' && distance(p, b) < 26);
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
  try { return structuredClone({ version: s.version, duration: DURATION, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: s.map.items, gates: s.map.gates, projectiles: s.projectiles, effects: s.effects, events: s.events }); }
  finally { stop('sim.snapshot'); }
}
