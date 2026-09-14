import { generateMap, WORLD_WIDTH, WORLD_HEIGHT } from '../map.ts';
import { SLOT_COUNT } from '../equipment.ts';
import { VERSION, KITS } from './rules.ts';
import { queueInput, resetInput } from './input.ts';
import { defaultContent } from './content.ts';
import type { Game, GameMap, Kit, Player, PlayerId, PlayerInput, Role, SlotIndex } from '../types.ts';

/**
 * `map` defaults to the one `seed` generates. Supplying it instead pins the arena a game runs in,
 * which is what lets behaviour be characterized against a stored map rather than against whatever
 * the current generator emits — see [31](../../docs/31-verification.md). The game mutates what it is
 * given (items are taken, gates open), so a caller reusing a map passes a copy.
 */
export function createGame(seed = 4217, map: GameMap = generateMap(seed), content = defaultContent()): Game {
  const s: Game = { version: VERSION, content, seed, rng: seed || 1, tick: 0, phase: 'live', map, players: [], projectiles: [], effects: [], events: [], slots: 3, hazardX: -80, serial: 0 };
  // Identifier and iteration order are part of the recorded contract, so both are derived from the
  // roster's own order rather than from anything that could reorder independently of it.
  for (const [i, name] of s.content.roster.contestants.entries()) s.players.push(makePlayer(`c${i}` as PlayerId, name, 'contestant', 'warden', i));
  for (const [i, g] of s.content.roster.gladiators.entries()) s.players.push(makePlayer(`g${i}` as PlayerId, g.name, 'gladiator', g.kit, i));
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
  if (Object.hasOwn(s.content.kits, kit)) p.kit = kit;
  resetInput(p); delete p.viewLagTicks; p.path = [];
  return p;
}
/**
 * Accept one client input into that player's queue, or reject it.
 *
 * Returns the accepted input so a caller can record exactly what was queued, and literal `false`
 * on rejection. A tick spends one of these; see `input.ts` for why that replaced coalescing.
 */
export function setInput(s: Game, id: PlayerId, input: PlayerInput | null | undefined): PlayerInput | false {
  const p = s.players.find(p => p.id === id);
  if (!p) return false;
  return queueInput(p, input, s.tick) ?? false;
}
