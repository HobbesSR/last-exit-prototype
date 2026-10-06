import { zoneSizeName } from '../map/live.ts';
import * as profiler from '../shared/profiler.ts';
export const SPECTATOR_DELAY_TICKS = 60;
export const send = (session, value) => session.deliver(JSON.stringify(value));
const lobbyPayload = room => ({
  type: 'lobby', room: room.id, name: room.name, started: room.started, matchmade: !!room.matchmade, size: zoneSizeName(room.size),
  startsAt: room.startsAt || null,
  // Whether the map exists yet (#258), and whether the owner has asked to start as soon as it does.
  ready: !!room.match, starting: !!room.startRequested,
  // Counted from the match's own roster, so a lobby never advertises places a match does not hold.
  capacity: { contestant: room.seats.capacity('contestant'), gladiator: room.seats.capacity('gladiator') },
  players: room.seats.roster().map(p => ({ id: p.id, name: p.name, role: p.role, kit: p.kit }))
});
export function broadcastLobby(room) {
  const payload = JSON.stringify(lobbyPayload(room));
  for (const session of room.clients) session.deliver(payload);
}
export function spectatorFrame(room) {
  const cutoff = Math.max(0, room.match.tick - SPECTATOR_DELAY_TICKS);
  return room.history.findLast(frame => frame.tick <= cutoff) || room.history[0] || room.match.snapshot();
}
// One entry per tick: a paused room re-broadcasts its current tick (a dev teleport), and appending each
// of those would push the delayed frame out of the window and give spectators the present.
export function remember(room, frame) {
  if (room.history.at(-1)?.tick === frame.tick) room.history[room.history.length - 1] = frame;
  else room.history.push(frame);
  while (room.history.length > SPECTATOR_DELAY_TICKS + 2) room.history.shift();
}
export function broadcast(room, state) {
  const payloads = new Map(), delayed = spectatorFrame(room);
  for (const session of room.clients) {
    // The dev view is the directed view without the delay: every dev session shares one payload.
    const key = session.playerId || (session.dev ? 'dev' : 'spectator');
    let payload = payloads.get(key);
    if (payload === undefined) payloads.set(key, payload = JSON.stringify({ type: 'state', state: room.match.project(session.playerId || session.dev ? state : delayed, session.playerId) }));
    session.deliver(payload, true);
  }
  profiler.count('loop.viewsBuilt', payloads.size); profiler.count('loop.viewsSent', room.clients.size);
}
