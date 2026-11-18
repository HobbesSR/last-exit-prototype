import { waitingSeats } from '../shared/simulation/waiting.ts';
import { zoneSizeName } from '../map/live.ts';
import * as profiler from '../shared/profiler.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';
import { createDiscoveryEncoder } from '../shared/discovery.ts';
import { stringifyWithMap } from './map-payload.js';
import { assertServerMessage, lobbyMessage, stateMessage, seatsMessage } from './protocol.js';
import { wireCodec } from '../shared/wire-schema.ts';
export const SPECTATOR_DELAY_TICKS = 60;
export const send = (session, value) => session.deliver(stringifyWithMap(assertServerMessage(value)));
/**
 * A `state` message written as a session's join negotiated (24.1): the descriptor codec's bytes, or JSON text
 * for a dev-tools session that asked for it. Every other message is JSON. A payload is a Uint8Array exactly
 * when it is binary, which is how the transport below tells a binary frame from text.
 */
const writeState = (frame, encoding) => {
  const message = stateMessage(frame);
  return encoding === 'json' ? JSON.stringify(message) : wireCodec().encode(message);
};
const lobbyPayload = room => lobbyMessage({
  room: room.id, name: room.name, started: room.started, matchmade: !!room.matchmade, size: zoneSizeName(room.size),
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
/**
 * Roster revisions (#1131, 24.4). A revision names a roster's content within its room: each distinct roster is
 * numbered when first seen, and keeps that number wherever it appears again, so a delayed view names the
 * roster its captured frame had, and the yard's and the match's never collide. It identifies a roster, not an
 * order: a client compares it for equality with the one it holds.
 */
function createRosterRevisions() {
  const revisions = new Map();
  return json => {
    let revision = revisions.get(json);
    if (revision === undefined) revisions.set(json, revision = revisions.size + 1);
    return revision;
  };
}
const rosterJson = new WeakMap();
const rosterText = roster => { let json = rosterJson.get(roster); if (json === undefined) rosterJson.set(roster, json = JSON.stringify(roster)); return json; };
/** A roster and its revision as one `seats` payload, built once per roster and revision. */
const seatPayloads = new WeakMap();
function seatsPayload(roster, revision) {
  let byRevision = seatPayloads.get(roster);
  if (!byRevision) seatPayloads.set(roster, byRevision = new Map());
  let json = byRevision.get(revision);
  if (!json) byRevision.set(revision, json = JSON.stringify(seatsMessage(roster, revision)));
  return { revision, json };
}
/** A session is sent `seats` when the revision its next state names is not the one it holds. */
function deliverSeats(session, seats) {
  if (session.rosterRevision === seats.revision) return true;
  if (session.deliver(seats.json) === false) return false;
  session.rosterRevision = seats.revision;
  return true;
}
/** Each player's frame of the waiting area (#236); those watching see the match map, not this. */
export function broadcastWaiting(room, view) {
  const roster = waitingSeats(room.waiting), seats = seatsPayload(roster, room.rosterRevisions(rosterText(roster)));
  for (const session of room.clients) if (session.playerId) {
    if (!deliverSeats(session, seats)) continue;
    session.deliver(writeState({ ...view(room.waiting, session.playerId), rosterRevision: seats.revision }, session.stateEncoding), true);
  }
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
      const captured = session.playerId || session.dev ? state : delayed;
      const projected = room.match.project(captured, session.playerId);
      profiler.start('loop.encode');
      const layers = encoderFor(room.layerEncoders, key, createLayerEncoder).encode(projected);
      const me = session.playerId && projected.self;
      if (me?.discovered) layers.discovered = encoderFor(room.discoveryEncoders, key, createDiscoveryEncoder).encode(me.discovered);
      profiler.stop('loop.encode');
      const roster = room.match.seatMetadata(captured);
      views.set(key, view = { state: projected, layers, roster: seatsPayload(roster, room.rosterRevisions(rosterText(roster))) });
    }
    // Items, gates and contestant discovery go as changes against a keyframe, and whole to a session
    // not yet delivered that keyframe (shared/frame-layers.ts, shared/discovery.ts). Sessions in the
    // same place and encoding share one payload.
    if (!deliverSeats(session, view.roster)) continue;
    const held = session.layerKeys ||= {};
    const whole = Object.entries(view.layers).filter(([layer, encoded]) => 'k' in encoded && held[layer] !== encoded.k).map(([layer]) => layer);
    const variant = `${key}|${whole}|${session.stateEncoding}`;
    let payload = payloads.get(variant);
    if (payload === undefined) {
      // The revision is the transport's, like the layers: the projection does not carry it.
      const frame = { ...view.state, rosterRevision: view.roster.revision };
      for (const [layer, encoded] of Object.entries(view.layers)) {
        if (layer === 'discovered') continue;
        frame[layer] = 'plain' in encoded ? encoded.plain : whole.includes(layer) ? encoded.all() : encoded.changes;
      }
      if (view.layers.discovered) {
        const disc = whole.includes('discovered') ? view.layers.discovered.all() : view.layers.discovered.changes;
        frame.self = { ...frame.self, discovered: disc };
      }
      profiler.start('loop.serialize');
      payloads.set(variant, payload = writeState(frame, session.stateEncoding));
      profiler.stop('loop.serialize');
    }
    if (session.deliver(payload, true) !== false) for (const layer of whole) held[layer] = view.layers[layer].k;
  }
  // A view nobody holds any more (a player who left) takes its keyframes with it.
  for (const encoders of [room.layerEncoders, room.discoveryEncoders]) for (const key of encoders.keys()) if (!views.has(key)) encoders.delete(key);
  profiler.count('loop.viewsBuilt', views.size); profiler.count('loop.viewsSent', room.clients.size);
}
/** The keyframe encoders a room's views keep, one of each kind per view, and its roster revisions. Every room starts with them. */
export function viewEncoders() {
  return { layerEncoders: new Map(), discoveryEncoders: new Map(), rosterRevisions: createRosterRevisions() };
}
function encoderFor(encoders, key, create) {
  let encoder = encoders.get(key);
  if (!encoder) encoders.set(key, encoder = create());
  return encoder;
}
