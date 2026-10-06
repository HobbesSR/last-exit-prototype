import { DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { randomSeed } from './protocol.js';
import { send } from './room-views.js';
export const MAX_ROOMS = 8;
const FULL = { type: 'error', message: 'All arena slots are occupied. Try matchmaking again after a match ends.' };

/**
 * The directory (22.5): which rooms exist, creating them, and choosing one for a matchmaking player.
 * It holds no simulation and never touches a room: it reads the host's summaries, which are plain
 * data, and answers with a room id. The host is the room service, in this process for now (41).
 */
export function createRoomDirectory({ host, generateMap = null, devTools = 'none' }) {
  const hasCapacity = () => host.accepting() && host.summaries().length < MAX_ROOMS;
  /**
   * A new room, or null at capacity. It exists, and can be joined, at once: its map is made by
   * `generateMap` when the directory has one (a worker, so no other room's ticks wait on it) and arrives
   * later (#258). Without one the map is generated inline, which is what the fake-clock tests use.
   */
  function createRoom(seed, matchmade = false, size = DEFAULT_LIVE_ZONE_SIZE) {
    if (!hasCapacity()) return null;
    return host.makeRoom(seed, matchmade, size, generateMap?.(seed, size));
  }
  /**
   * The rooms a lobby browser may show. Everyone sees matchmade rooms still filling; private rooms are
   * reached by link, and live ones only through the dev view (17.4 #9), so a server whose dev tools
   * policy admits every session lists every open room. Under `owner` admission needs a room's own key,
   * which an anonymous listing does not have.
   */
  const list = () => host.summaries().filter(room => devTools === 'all' || room.kind === 'matchmade' && room.phase === 'lobby');
  /** A matchmade room still filling with a place left: whichever role the player prefers, admission falls back. */
  const filling = () => host.summaries().find(room => room.kind === 'matchmade' && room.phase === 'lobby' && room.open.contestant + room.open.gladiator > 0);
  /** The room id a matchmaking player should join, creating a room when none is filling, or null at capacity. */
  function match() {
    const found = filling();
    if (found) return found.id;
    return createRoom(randomSeed(), true)?.id ?? null;
  }
  /**
   * Session messages, with `match` answered here and joined like any other room id. In one process this
   * stands in for a client asking the directory and then connecting to the room it names.
   */
  function receive(session, data) {
    if (data.type !== 'match' || session.room) return host.receive(session, data);
    if (!host.accepting()) return;
    const answer = match();
    if (!answer) return send(session, FULL);
    const role = ['contestant', 'gladiator'].includes(data.role) ? data.role : 'any';
    host.receive(session, { ...data, type: 'join', room: answer, role });
  }
  return { hasCapacity, createRoom, list, match, receive };
}
