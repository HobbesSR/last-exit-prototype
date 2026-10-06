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
export function createRoomDirectory({ host, generateMap = null, devTools = 'none', reportError = console.error }) {
  // Rooms whose maps are still being generated hold their place against the cap.
  let generating = 0, matchmadeRoom = null;
  const hasCapacity = () => host.accepting() && host.summaries().length + generating < MAX_ROOMS;
  /**
   * A new room, its map made by `generateMap` when the directory has one (a worker, so no other room's
   * ticks wait on it): a promise of the room, or null at capacity. Without one, the room is returned
   * at once, generated inline, which is what the fake-clock tests use.
   */
  function createRoom(seed, matchmade = false, size = DEFAULT_LIVE_ZONE_SIZE) {
    if (!hasCapacity()) return null;
    if (!generateMap) return host.makeRoom(seed, matchmade, size);
    generating++;
    return generateMap(seed, size).then(map => { generating--; return host.makeRoom(seed, matchmade, size, map); },
      error => { generating--; throw error; });
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
  /**
   * The room id a matchmaking player should join, creating a room when none is filling: an id, null at
   * capacity, or a promise to ask again once the room being generated is ready.
   */
  function match() {
    const found = filling();
    if (found) return found.id;
    // Everyone matchmaking while a room's map is generated waits for that one room.
    const made = matchmadeRoom || createRoom(randomSeed(), true);
    if (made && typeof made.then === 'function') {
      if (!matchmadeRoom) {
        matchmadeRoom = made;
        made.then(() => { matchmadeRoom = null; }, () => { matchmadeRoom = null; });
      }
      return made;
    }
    return made ? made.id : null;
  }
  /**
   * Session messages, with `match` answered here and joined like any other room id. In one process this
   * stands in for a client asking the directory and then connecting to the room it names.
   */
  function receive(session, data) {
    if (data.type !== 'match' || session.room) return host.receive(session, data);
    if (!host.accepting()) return;
    const answer = match();
    if (answer && typeof answer.then === 'function') {
      answer.then(ready => { if (session.closed || session.room) return; if (ready) receive(session, data); else send(session, FULL); },
        error => { reportError(error); if (!session.closed) send(session, { type: 'error', message: 'The arena could not be generated. Try again.' }); });
      return;
    }
    if (!answer) return send(session, FULL);
    const role = ['contestant', 'gladiator'].includes(data.role) ? data.role : 'any';
    host.receive(session, { ...data, type: 'join', room: answer, role });
  }
  return { hasCapacity, createRoom, list, match, receive };
}
