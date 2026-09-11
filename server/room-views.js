import * as profiler from '../shared/profiler.js';
export const SPECTATOR_DELAY_TICKS = 60;
export const send = (session, value) => session.deliver(JSON.stringify(value));
export const lobbyPayload = room => ({
  type: 'lobby', room: room.id, started: room.started, matchmade: !!room.matchmade,
  startsAt: room.startsAt || null,
  players: room.match.roster().map(p => ({ id: p.id, name: p.name, role: p.role, kit: p.kit }))
});
export function broadcastLobby(room) {
  const payload = JSON.stringify(lobbyPayload(room));
  for (const session of room.clients) session.deliver(payload);
}
export function spectatorFrame(room) {
  const cutoff = Math.max(0, room.match.tick - SPECTATOR_DELAY_TICKS);
  return room.history.findLast(frame => frame.tick <= cutoff) || room.history[0] || room.match.snapshot();
}
export function remember(room, frame) {
  room.history.push(frame);
  while (room.history.length > SPECTATOR_DELAY_TICKS + 2) room.history.shift();
}
export function broadcast(room, state) {
  const payloads = new Map(), delayed = spectatorFrame(room);
  for (const session of room.clients) {
    const key = session.playerId || 'spectator';
    let payload = payloads.get(key);
    if (payload === undefined) payloads.set(key, payload = JSON.stringify({ type: 'state', state: room.match.project(session.playerId ? state : delayed, session.playerId) }));
    session.deliver(payload);
  }
  profiler.count('loop.viewsBuilt', payloads.size); profiler.count('loop.viewsSent', room.clients.size);
}
