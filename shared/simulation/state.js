import { generateMap, WORLD_WIDTH, WORLD_HEIGHT } from '../map.js';
import { SLOT_COUNT } from '../equipment.js';
import { VERSION, KITS } from './rules.js';
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
