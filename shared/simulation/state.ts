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
  for (const role of ['contestant', 'gladiator'] as const) {
    for (let i = 0; i < placeCount(s, role); i++) { const { id, name, kit } = rosterBot(s, role, i); s.players.push(makePlayer(id, name, role, kit, i)); }
  }
  for (const p of s.players) if (p.role === 'contestant') { p.inventory = Array(SLOT_COUNT).fill(null); p.selectedSlot = 0; }
  s.players.filter(p => p.role === 'contestant').forEach((p, i) => Object.assign(p, map.spawns[i]));
  s.players.filter(p => p.role === 'gladiator').forEach((p, i) => {
    const station = map.hunterSpawns?.[i] ?? map.stations.at(-1 - i) ?? map.exit; p.x = station.x; p.y = station.y;
  });
  return s;
}
const placeCount = (s: Game, role: Role) => role === 'gladiator' ? s.content.roster.gladiators.length : s.content.roster.contestants.length;
// Who holds a roster place while no one has joined it: its id, name and kit, from the roster's own order.
function rosterBot(s: Game, role: Role, index: number): { id: PlayerId; name: string; kit: Kit } {
  if (role === 'contestant') return { id: `c${index}` as PlayerId, name: s.content.roster.contestants[index]!, kit: 'warden' };
  const g = s.content.roster.gladiators[index]!;
  return { id: `g${index}` as PlayerId, name: g.name, kit: g.kit };
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
 * Move a joined player before the match starts (#235): into an open place of `role`, or keep their own
 * when the role is unchanged, taking `kit` when the content offers it. The place they leave goes back to
 * its roster bot's id, name and kit, so identifiers stay unique.
 */
export function changeSeat(s: Game, id: PlayerId, role: Role, kit?: Kit): Player | null {
  if (s.phase !== 'live') return null;
  const from = s.players.find(p => p.id === id && !p.bot);
  if (!from) return null;
  const to = role === from.role ? from : s.players.find(p => p.bot && p.role === role && p.status === 'active');
  if (!to) return null;
  if (to !== from) {
    const { name } = from;
    Object.assign(from, rosterBot(s, from.role, s.players.filter(p => p.role === from.role).indexOf(from)), { bot: true });
    resetInput(from); delete from.viewLagTicks; delete from.path;
    to.id = id; to.name = name; to.bot = false;
    resetInput(to); delete to.viewLagTicks; to.path = [];
  }
  if (kit !== undefined && Object.hasOwn(s.content.kits, kit)) to.kit = kit;
  return to;
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
