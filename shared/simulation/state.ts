import { generateMap, WORLD_WIDTH, WORLD_HEIGHT } from '../map.ts';
import { SLOT_COUNT } from '../equipment.ts';
import { VERSION, KITS } from './rules.ts';
import { finite, integer, safeInteger } from '../numbers.ts';
import type { Game, Kit, Player, PlayerId, PlayerInput, Role, SlotIndex } from '../types.ts';

export function createGame(seed = 4217): Game {
  const map = generateMap(seed);
  const s: Game = { version: VERSION, seed, rng: seed || 1, tick: 0, phase: 'live', map, players: [], projectiles: [], effects: [], events: [], slots: 3, hazardX: -80, serial: 0 };
  for (const [i, name] of ['Mica', 'Juno', 'Patch', 'Pip', 'Nova', 'Rook', 'Echo', 'Sol'].entries()) s.players.push(makePlayer(`c${i}` as PlayerId, name, 'contestant', 'warden', i));
  s.players.push(makePlayer('g0' as PlayerId, 'IRONCLAD', 'gladiator', 'warden', 0), makePlayer('g1' as PlayerId, 'VESPER', 'gladiator', 'specter', 1));
  for (const p of s.players) if (p.role === 'contestant') { p.inventory = Array(SLOT_COUNT).fill(null); p.selectedSlot = 0; }
  s.players.filter(p => p.role === 'contestant').forEach((p, i) => Object.assign(p, map.spawns[i]));
  s.players.filter(p => p.role === 'gladiator').forEach((p, i) => {
    const station = map.stations.at(-1 - i) ?? map.exit; p.x = station.x; p.y = station.y;
  });
  return s;
}
function makePlayer(id: PlayerId, name: string, role: Role, kit: Kit, index: number): Player {
  return { id, name, role, kit, bot: true, x: role === 'contestant' ? 1500 + index * 33 : WORLD_WIDTH - 1700 - index * 130, y: WORLD_HEIGHT / 2 + (role === 'contestant' ? (index % 3 - 1) * 25 : 0), hp: role === 'contestant' ? 100 : 360, maxHp: role === 'contestant' ? 100 : 360, shield: 0, keys: 0, weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0, input: {}, lastSeq: -1 };
}
export function joinGame(s: Game, id: PlayerId, role: Role = 'contestant', kit: Kit = 'warden', name = 'You'): Player | null {
  if (s.phase !== 'live') return null;
  const p = s.players.find(p => p.bot && p.role === role && p.status === 'active');
  if (!p) return null;
  p.id = id; p.name = name.slice(0, 16); p.bot = false;
  if (Object.hasOwn(KITS, kit)) p.kit = kit;
  p.input = {}; p.lastSeq = -1; p.path = [];
  return p;
}
export function setInput(s: Game, id: PlayerId, input: PlayerInput | null | undefined): boolean {
  const p = s.players.find(p => p.id === id);
  if (!p || !input || !safeInteger(input.seq) || input.seq <= p.lastSeq) return false;
  const axis = (v: unknown) => finite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  p.lastSeq = input.seq;
  // Axes and held buttons are replaced, but one-shot presses are latched. Clients send on their own
  // interval, so two messages can arrive between two ticks, and the second must not erase a button
  // press the first one carried before any tick had a chance to read it.
  p.input = { x: axis(input.x), y: axis(input.y), aim: finite(input.aim) ? input.aim : 0, attack: input.attack === true,
    skill: input.skill === true || p.input.skill === true, interact: input.interact === true || p.input.interact === true, drop: input.drop === true || p.input.drop === true, sneak: input.sneak === true,
    slot: integer(input.slot) && input.slot >= 0 && input.slot < SLOT_COUNT ? input.slot as SlotIndex : p.input.slot,
    moveSlot: input.moveSlot && integer(input.moveSlot.from) && integer(input.moveSlot.to)
      && input.moveSlot.from >= 0 && input.moveSlot.from < SLOT_COUNT && input.moveSlot.to >= 0 && input.moveSlot.to < SLOT_COUNT
      ? { from: input.moveSlot.from, to: input.moveSlot.to } : p.input.moveSlot };
  p.inputTick = s.tick; return true;
}
