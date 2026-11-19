import { waitingSeats } from '../shared/simulation/waiting.ts';
import { zoneSizeName } from '../map/live.ts';
import * as profiler from '../shared/profiler.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';
import { createDiscoveryEncoder } from '../shared/discovery.ts';
import { stringifyWithMap } from './map-payload.js';
import { assertServerMessage, fastMessage, lobbyMessage, slowMessage, stateMessage, seatsMessage } from './protocol.js';
import { wireCodec } from '../shared/wire-schema.ts';
import { against } from '../shared/wire-codec.ts';
import { createEventWindow, createFastHistory, fastFrame, MAX_FAST_DATAGRAM_BYTES } from '../shared/fast-state.ts';
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
 * roster its captured frame had. Two rosters share a revision only when their metadata is identical (a yard
 * and a match of the same people), so a client never draws with the wrong one. It identifies a roster, not an
 * order: a client compares it for equality with the one it holds. The `seats` payload is built once per
 * revision, so a tick that changes no roster serializes nothing but the content key.
 */
function createRosterRevisions() {
  const byContent = new Map();
  return roster => {
    const text = rosterText(roster);
    let seats = byContent.get(text);
    if (!seats) {
      const revision = byContent.size + 1;
      byContent.set(text, seats = { revision, json: JSON.stringify(seatsMessage(roster, revision)) });
    }
    return seats;
  };
}
const rosterJson = new WeakMap();
const rosterText = roster => { let json = rosterJson.get(roster); if (json === undefined) rosterJson.set(roster, json = JSON.stringify(roster)); return json; };
/** A roster's revision in this room, as a welcome or ready names it beside the roster it delivers. */
export const rosterRevision = (room, roster) => room.rosterRevisions(roster).revision;
/** A session is sent `seats` when the revision its next state names is not the one it holds. */
function deliverSeats(session, seats) {
  if (session.rosterRevision === seats.revision) return true;
  if (session.deliver(seats.json) === false) return false;
  session.rosterRevision = seats.revision;
  return true;
}
/** Each player's frame of the waiting area (#236); those watching see the match map, not this. */
export function broadcastWaiting(room, view) {
  const seats = room.rosterRevisions(waitingSeats(room.waiting));
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
  const views = new Map(), payloads = new Map(), delayed = spectatorFrame(room), fastViews = new Set();
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
      views.set(key, view = { state: projected, layers, roster: room.rosterRevisions(room.match.seatMetadata(captured)) });
    }
    // Marked before the roster can hold the frame back: a window kept through a skipped tick stays unbroken.
    if (deliversFast(session)) fastViews.add(key);
    if (!deliverSeats(session, view.roster)) continue;
    if (deliversFast(session)) { deliverSplit(room, session, key, view); continue; }
    // Items, gates and contestant discovery go as changes against a keyframe, and whole to a session
    // not yet delivered that keyframe (shared/frame-layers.ts, shared/discovery.ts). Sessions in the
    // same place and encoding share one payload.
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
  // A view nobody holds any more (a player who left) takes its keyframes and slow version with it, and a view not
  // delivered fast (one resumed on a WebSocket) its event window.
  for (const encoders of [room.layerEncoders, room.discoveryEncoders, room.slowVersions]) for (const key of encoders.keys()) if (!views.has(key)) encoders.delete(key);
  for (const key of room.fastEvents.keys()) if (!fastViews.has(key)) room.fastEvents.delete(key);
  profiler.count('loop.viewsBuilt', views.size); profiler.count('loop.viewsSent', room.clients.size);
}
/**
 * How a session is sent match frames (24.5 "Stage 3's contracts"), one condition: a player session with
 * datagrams and binary state gets the split, fast state on datagrams and the slow layers on its stream. A shared
 * view (dev, delayed spectators), a session without datagrams, or a JSON session gets today's `state` on the
 * stream, as 24.2 decision 2 gives the shared views. There is no second delta path.
 */
export const deliversFast = session => Boolean(session.playerId && session.datagrams && session.stateEncoding === 'binary');

const SLOW_LAYERS = ['items', 'gates', 'discovered'];
/**
 * A player view's slow layers this tick, and their version: a number that changes, per view, whenever what the
 * layers say changes (a new keyframe, or new changes against one). It is compared by content, so a tick that
 * changes no item, gate or discovery sends no `slow` message.
 */
function slowLayers(room, key, view) {
  if (view.slow) return view.slow;
  const changes = {};
  for (const layer of SLOW_LAYERS) {
    const encoded = view.layers[layer];
    if (encoded) changes[layer] = 'plain' in encoded ? encoded.plain : encoded.changes;
  }
  const text = JSON.stringify(changes), held = room.slowVersions.get(key);
  const version = held?.text === text ? held.version : (held?.version ?? 0) + 1;
  if (held?.version !== version) room.slowVersions.set(key, { version, text });
  return view.slow = { version, changes };
}

/**
 * The split delivery to one player session (24.2, 24.5 stage 3). The slow layers go on the stream as a `slow`
 * message when the session does not hold their current version, as keyframe layers exactly as `state` carries
 * them. The fast part goes as a `fast` message on a datagram: a delta against the newest frame the session has
 * acknowledged while the history still holds it, else whole, so a session that has acknowledged nothing yet is
 * sent the whole frame every tick. Each sent frame joins the session's history. A message too large for
 * `MAX_FAST_DATAGRAM_BYTES` goes on the stream instead, where it can be skipped like a `state` frame. The fast part
 * carries the view's event window (`createEventWindow`), so an event outlives the loss of the frames that held it.
 */
function deliverSplit(room, session, key, view) {
  const slow = slowLayers(room, key, view);
  const held = session.layerKeys ||= {};
  const whole = SLOW_LAYERS.filter(layer => view.layers[layer] && 'k' in view.layers[layer] && held[layer] !== view.layers[layer].k);
  if (session.slowVersion !== slow.version || whole.length) {
    const layers = {};
    for (const [layer, changes] of Object.entries(slow.changes)) layers[layer] = whole.includes(layer) ? view.layers[layer].all() : changes;
    profiler.start('loop.serialize');
    const bytes = wireCodec().encode(slowMessage({ slowVersion: slow.version, ...layers }));
    profiler.stop('loop.serialize');
    if (session.deliver(bytes, true) !== false) {
      session.slowVersion = slow.version;
      for (const layer of whole) held[layer] = view.layers[layer].k;
    }
  }
  const frame = view.fast ??= encoderFor(room.fastEvents, key, createEventWindow)(fastFrame(view.state));
  const history = session.fastHistory ??= createFastHistory();
  const base = session.fastAck === null || session.fastAck === undefined ? undefined : history.get(session.fastAck);
  profiler.start('loop.serialize');
  const bytes = wireCodec().encode(fastMessage({
    rosterRevision: view.roster.revision, slowVersion: slow.version,
    state: base ? against(session.fastAck, base, frame) : frame,
  }));
  profiler.stop('loop.serialize');
  profiler.count(base ? 'loop.fastDelta' : 'loop.fastWhole');
  // 24.2 asks that overflow be counted in production: a steady rate of it is the cue for priority packing.
  // The limit is the edge's: four fragments of DATAGRAM_PAYLOAD_BYTES (fast-state.ts), past which it sends nothing.
  const streamed = bytes.length > MAX_FAST_DATAGRAM_BYTES;
  if (streamed) profiler.count('loop.fastStreamed');
  const sent = streamed ? session.deliver(bytes, true) !== false : session.datagram(bytes) !== false;
  if (sent) history.record(frame.tick, frame);
}

/**
 * The keyframe encoders a room's views keep, one of each kind per view, its slow layers' versions, its fast views'
 * event windows and its roster revisions. Every room starts with them.
 */
export function viewEncoders() {
  return { layerEncoders: new Map(), discoveryEncoders: new Map(), slowVersions: new Map(), fastEvents: new Map(), rosterRevisions: createRosterRevisions() };
}
function encoderFor(encoders, key, create) {
  let encoder = encoders.get(key);
  if (!encoder) encoders.set(key, encoder = create());
  return encoder;
}
