import { zoneSizeName } from '../map/live.ts';
import * as profiler from '../shared/profiler.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';
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
/** Each player's frame of the waiting area (#236); those watching see the match map, not this. */
export function broadcastWaiting(room, view) {
  for (const session of room.clients) if (session.playerId) session.deliver(JSON.stringify({ type: 'state', state: view(room.waiting, session.playerId) }), true);
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
  const views = new Map(), payloads = new Map(), delayed = spectatorFrame(room);
  for (const session of room.clients) {
    // The dev view is the directed view without the delay: every dev session shares one payload.
    const key = session.playerId || (session.dev ? 'dev' : 'spectator');
    let view = views.get(key);
    if (view === undefined) {
      const projected = room.match.project(session.playerId || session.dev ? state : delayed, session.playerId);
      views.set(key, view = { state: projected, layers: encoderFor(room, key).encode(projected) });
    }
    // Items and gates go as changes against a keyframe, and whole to a session not yet delivered that
    // keyframe (shared/frame-layers.ts). Sessions in the same place share one payload.
    const held = session.layerKeys ||= {};
    const whole = Object.entries(view.layers).filter(([layer, encoded]) => 'k' in encoded && held[layer] !== encoded.k).map(([layer]) => layer);
    const variant = `${key}|${whole}`;
    let payload = payloads.get(variant);
    if (payload === undefined) {
      const frame = { ...view.state };
      for (const [layer, encoded] of Object.entries(view.layers)) frame[layer] = 'plain' in encoded ? encoded.plain : whole.includes(layer) ? encoded.all() : encoded.changes;
      payloads.set(variant, payload = JSON.stringify({ type: 'state', state: frame }));
    }
    if (session.deliver(payload, true) !== false) for (const layer of whole) held[layer] = view.layers[layer].k;
  }
  // A view nobody holds any more (a player who left) takes its keyframes with it.
  for (const key of room.layerEncoders?.keys() ?? []) if (!views.has(key)) room.layerEncoders.delete(key);
  profiler.count('loop.viewsBuilt', views.size); profiler.count('loop.viewsSent', room.clients.size);
}
function encoderFor(room, key) {
  const encoders = room.layerEncoders ||= new Map();
  let encoder = encoders.get(key);
  if (!encoder) encoders.set(key, encoder = createLayerEncoder());
  return encoder;
}
