import { indexRoster, playerById } from './relations.ts';
import { assertEnumKeys, KITS, WEAPONS } from '../enum-tables.ts';
import { WORLD_WIDTH, WORLD_HEIGHT } from '../map.ts';
import { SLOT_COUNT } from '../equipment.ts';
import { DEFAULT_KIT, INITIAL_ESCAPE_SLOTS, MAX_PLAYER_NAME, ROLES, VERSION } from './rules.ts';
import { queueInput, queueSanitizedInput, resetInput } from './input.ts';
import type { SanitizedInput } from './input.ts';
import { defaultContent } from './content.ts';
import { clearRoute } from './geometry.ts';
import { createDiscovery, attachDiscovery, discover } from '../discovery.ts';
import { initializeItemInstances } from '../item-instances.ts';
import { assignWeaponQualities } from '../loot-tiers.ts';
import { loadMapWeapons, seedAmmo } from './ammo.ts';
import type { Game, GameMap, ItemAllocator, ItemId, Kit, MatchMap, Player, PlayerId, PlayerInput, Role } from '../types.ts';
import type { CoreSight } from '../sight-core.ts';

/**
 * `map` is the arena the game runs in, which is what lets behaviour be characterized against a stored
 * map rather than against whatever the current generator emits — see [31](../../docs/31-verification.md).
 * The game takes what it is given: its ground items and traps move off the map onto the game (#1211), and
 * the game mutates them and its gates (items are taken, gates open), so a caller reusing a map passes a copy.
 * `content` defaults to the shipped set. This builds the record only: `createGame` builds on it
 * and is what steps, so a game from here alone suits code that reads a match without running it.
 * `sight` is the core binding discovery's first sample runs through; without it, contestants start with
 * nothing discovered until a game steps (#1210).
 * `itemAllocator` binds core allocation before item normalization; bare records use synchronous setup.
 */
export function createGameRecord(seed: number, map: GameMap, content = defaultContent(), sight?: CoreSight, itemAllocator?: ItemAllocator): Game {
  assertEnumKeys(content.weapons, WEAPONS, 'weapon');
  assertEnumKeys(content.kits, KITS, 'kit');
  const { items, traps } = map as unknown as GameMap<ItemId>, fieldOrder = Object.keys(map);
  // The same map object, so caches built on it before the game keep hitting; it no longer holds the live stores.
  delete (map as Partial<GameMap>).items; delete (map as Partial<GameMap>).traps;
  const arena = map as unknown as MatchMap;
  mapFieldOrders.set(arena, fieldOrder);
  const s: Game = { version: VERSION, content, seed, rng: seed || 1, tick: 0, phase: 'live', map: arena, items, traps, gates: arena.gates, players: [], projectiles: [], effects: [], events: [], slots: INITIAL_ESCAPE_SLOTS, hazardX: -80, serial: 0 };
  if (itemAllocator) s.itemAllocator = itemAllocator;
  // Identifier and iteration order are part of the recorded contract, so both are derived from the
  // roster's own order rather than from anything that could reorder independently of it.
  for (const role of ROLES) {
    for (let i = 0; i < placeCount(s, role); i++) {
      const { id, name, kit } = rosterBot(s, role, i), p = makePlayer(id, name, role, kit, i);
      if (role === 'contestant') attachSeat(p, i);
      s.players.push(p);
    }
  }
  indexRoster(s.players);
  for (const p of s.players) if (p.role === 'contestant') { p.inventory = Array(SLOT_COUNT).fill(null); p.selectedSlot = 0; }
  s.players.filter(p => p.role === 'contestant').forEach((p, i) => Object.assign(p, map.spawns[i]));
  s.players.filter(p => p.role === 'gladiator').forEach((p, i) => {
    const station = map.hunterSpawns?.[i] ?? map.stations.at(-1 - i) ?? map.exit; p.x = station.x; p.y = station.y;
  });
  if (!content.itemInstances || typeof content.itemInstances !== 'object') throw new RangeError('item instances required');
  if (!content.actorPhysics || typeof content.actorPhysics !== 'object') throw new RangeError('actor physics required');
  if (!content.worldPhysics || typeof content.worldPhysics !== 'object') throw new RangeError('world physics required');
  if (!content.hook || typeof content.hook !== 'object' || !content.kits?.hook) throw new RangeError('hook configuration required');
  if (content.dynamicNavigation !== true) throw new RangeError('dynamic navigation required');
  const itemInstances = Object.freeze({ ...content.itemInstances });
  s.content = Object.freeze({ ...content, itemInstances });
  const rest = loadMapWeapons(s);
  initializeItemInstances(s);
  assignWeaponQualities(s);
  seedAmmo(s, rest);
  if (content.discovery) {
    for (const p of s.players) {
      if (p.role === 'contestant') {
        const memory = createDiscovery();
        attachDiscovery(p, memory);
        // The lobby's NOWHERE map has no dimensions or spawns; discovery sampling runs only once on a real map.
        if (sight && map.width && map.height && map.spawns?.length) discover(sight, memory, s.map, p, undefined, p.bot, s.items);
      }
    }
  }
  return s;
}

/** Each arena's field order as its map had it, so a whole map built again serializes as it did. */
const mapFieldOrders = new WeakMap<MatchMap, readonly string[]>();
/**
 * The game's map whole again, with its live stores in the places the map had them: what a client or a recording
 * is sent. Fields given in `live` replace the game's own (a published ground, say). A new object each call.
 */
export function wholeMap(s: Game, live: Partial<Pick<GameMap<ItemId>, 'items' | 'traps' | 'gates'>> = {}): GameMap<ItemId> {
  const stores = { items: s.items, traps: s.traps, gates: s.gates, ...live } as Record<string, unknown>;
  const order = mapFieldOrders.get(s.map) ?? [...Object.keys(s.map), 'items', 'traps'], whole: Record<string, unknown> = {};
  for (const key of order) whole[key] = key in stores ? stores[key] : (s.map as unknown as Record<string, unknown>)[key];
  for (const key of Object.keys(s.map)) if (!(key in whole)) whole[key] = (s.map as unknown as Record<string, unknown>)[key];
  return whole as unknown as GameMap<ItemId>;
}
const placeCount = (s: Game, role: Role) => role === 'gladiator' ? s.content.roster.gladiators.length : s.content.roster.contestants.length;
// Who holds a roster place while no one has joined it: its id, name and kit, from the roster's own order.
function rosterBot(s: Game, role: Role, index: number): { id: PlayerId; name: string; kit: Kit } {
  if (role === 'contestant') return { id: `c${index}` as PlayerId, name: s.content.roster.contestants[index]!, kit: DEFAULT_KIT };
  const g = s.content.roster.gladiators[index]!;
  return { id: `g${index}` as PlayerId, name: g.name, kit: g.kit };
}
/**
 * Attach a contestant's roster place, the identity a client gives its hue (#792). It belongs to the
 * roster place rather than to whoever holds it, so joining, handing it back to a bot, resuming a
 * connection or changing kit or seat leaves it alone. It is ordinary recorded player state: a frame
 * carries the place its players held at that tick, and so does a recording.
 */
function attachSeat(player: Player, seat: number): void {
  player.seat = seat;
}
/** A roster place as a match first holds it, before the map has placed it. */
export function makePlayer(id: PlayerId, name: string, role: Role, kit: Kit, index: number): Player {
  return { id, name, role, kit, bot: true, x: role === 'contestant' ? 1500 + index * 33 : WORLD_WIDTH - 1700 - index * 130, y: WORLD_HEIGHT / 2 + (role === 'contestant' ? (index % 3 - 1) * 25 : 0), hp: role === 'contestant' ? 100 : 360, maxHp: role === 'contestant' ? 100 : 360, shield: 0, keys: 0, weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0, input: {}, lastSeq: -1 };
}
export function joinGame(s: Game, id: PlayerId, role: Role = 'contestant', kit: Kit = DEFAULT_KIT, name = 'You'): Player | null {
  if (s.phase !== 'live') return null;
  const p = s.players.find(p => p.bot && p.role === role && p.status === 'active');
  if (!p) return null;
  p.id = id; p.name = name.slice(0, MAX_PLAYER_NAME); p.bot = false;
  if (Object.hasOwn(s.content.kits, kit)) p.kit = kit;
  indexRoster(s.players, true);
  resetInput(p); delete p.viewLagTicks; clearRoute(p);
  return p;
}
/**
 * Move a joined player before the match starts (#235): into an open place of `role`, or keep their own
 * when the role is unchanged, taking `kit` when the content offers it. The place they leave goes back to
 * its roster bot's id, name and kit, so identifiers stay unique.
 */
export function changeSeat(s: Game, id: PlayerId, role: Role, kit?: Kit): Player | null {
  if (s.phase !== 'live') return null;
  const from = playerById(s, id);
  if (!from || from.bot) return null;
  const to = role === from.role ? from : s.players.find(p => p.bot && p.role === role && p.status === 'active');
  if (!to) return null;
  if (to !== from) {
    const { name } = from;
    Object.assign(from, rosterBot(s, from.role, s.players.filter(p => p.role === from.role).indexOf(from)), { bot: true });
    resetInput(from); delete from.viewLagTicks; delete from.route;
    to.id = id; to.name = name; to.bot = false;
    resetInput(to); delete to.viewLagTicks; clearRoute(to);
    indexRoster(s.players, true);
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
  const p = playerById(s, id);
  if (!p) return false;
  return queueInput(p, input, s.tick) ?? false;
}

/** Accept an input already validated and sanitized at the protocol boundary. */
export function setSanitizedInput(s: Game, id: PlayerId, input: SanitizedInput): SanitizedInput | false {
  const p = playerById(s, id);
  return p ? queueSanitizedInput(p, input, s.tick) ?? false : false;
}
