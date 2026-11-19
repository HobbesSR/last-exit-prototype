import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { wireCodec } from '../shared/wire-schema.ts';
import { MissingBaseline } from '../shared/wire-codec.ts';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { createDiscoveryDecoder } from '../shared/discovery.ts';
import { ANGLE_QUANTUM, createEventWindow, createFastHistory, createFastReader, fastFrame, holdItemBodies, keptEvents, quantize, FAST_HISTORY_TICKS, FAST_QUANTA, MAX_FAST_DATAGRAM_BYTES } from '../shared/fast-state.ts';
import { event, participant } from '../shared/simulation/loot.ts';
import { KEPT_EVENTS } from '../shared/simulation/rules.ts';
import { deliversFast } from '../server/room-views.js';
import { EFFECT_KINDS } from '../shared/enum-tables.ts';

// The split delivery (24.5 "Stage 3's contracts"): a player session with datagrams is sent its fast state on
// datagrams, as deltas against the newest frame it acknowledged, and its slow layers on the stream. A fake
// datagram peer stands in for the edge and the client: it loses datagrams, acknowledges late, and must rebuild
// every frame it keeps exactly as a stream peer in the same room is sent it.

const codec = wireCodec();
const TICKS = 120;

/**
 * One short room (the fast-delta test's): a gladiator owner on the stream, and a contestant behind a fake
 * datagram transport. `lose(i)` says whether the i-th datagram is lost; acknowledgements reach the server
 * `ackDelay` ticks after the frame arrives, and only every `ackEvery`-th kept frame is acknowledged. `projected`
 * holds what the server projected for the contestant at each tick, as the room's history would. `each(i, room)`
 * runs before the i-th tick, to arrange the match.
 */
async function play({ lose = () => false, ackDelay = 2, ackEvery = 1, each = () => {} } = {}) {
  const h = roomHarness({ reuseMaps: true });
  const made = await h.room();
  const received = [], acks = [], projected = new Map();
  let count = 0, largest = 0;
  const owner = h.joined(made, { ownerKey: made.ownerKey, role: 'gladiator' });
  const other = h.joined(made, { role: 'contestant' }, { datagram: bytes => { largest = Math.max(largest, bytes.length); if (!lose(count++)) received.push(bytes); return true; } });
  // The views the room projects for the contestant: what it sends, split, is checked against these.
  const project = made.match.project;
  made.match.project = (frame, id) => {
    const view = project(frame, id);
    if (id === other.session.playerId && view.phase !== 'waiting') projected.set(view.tick, view);
    return view;
  };
  const client = fakeClient();
  try {
    h.wake(50);
    owner.send({ type: 'start' });
    for (let i = 0; i < TICKS; i++) {
      each(i, made);
      h.wake(50);
      // The harness stamps an input from its peer's own `state` frames, and the datagram peer has none: both are
      // stamped from the owner's.
      const tick = owner.messages.findLast(m => m.type === 'state').state.tick + 1;
      for (const [p, n] of [[owner, i], [other, -i]]) p.send({ type: 'input', seq: i + 1, tick, up: n % 40 < 20, left: n % 30 < 10, right: n % 30 > 20, angle: n / 10 });
      for (const bytes of received.splice(0)) {
        const kept = client.receive(bytes);
        if (kept !== null && client.kept % ackEvery === 0) acks.push({ at: i + ackDelay, tick: kept });
      }
      while (acks.length && acks[0].at <= i) h.service.acknowledge(other.session, acks.shift().tick);
    }
    return { other, client, projected, sent: count, largest };
  } finally { await h.service.close(); }
}

/**
 * The client's side, through the reader its apply uses (`createFastReader`): it keeps only newer frames. `drawn`
 * holds the frames it would draw, with empty slow layers, and `arrived` the events as the reader first held them.
 */
function fakeClient() {
  const reader = createFastReader(), frames = [], drawn = [], arrived = [];
  reader.slow([], [], 0);
  const client = {
    frames, drawn, arrived, kept: 0, missing: 0, stale: 0, deltas: 0,
    /** Applies one datagram; the tick it now holds as newest, or null when it applied nothing. */
    receive(bytes) {
      let message;
      let delta = false;
      try { message = codec.decode(bytes, { baseline: tick => { delta = true; return reader.baseline(tick); } }); } catch (error) {
        if (error instanceof MissingBaseline) { client.missing++; return null; }
        throw error;
      }
      const newest = reader.newest();
      if (newest !== null && message.state.tick <= newest) { client.stale++; return null; }
      drawn.push(reader.fast(message)); arrived.push(...reader.arrived()); client.kept++; if (delta) client.deltas++;
      frames.push(message);
      return reader.newest();
    },
  };
  return client;
}

/** A datagram peer's slow layers, from its `slow` messages, decoded as a client decodes them. */
function slowLayers(peer) {
  const layers = createLayerDecoder(), discovery = createDiscoveryDecoder();
  return peer.rawMessages.filter(m => m.type === 'slow').map(m => {
    const decoded = layers.decode({ items: m.items, gates: m.gates });
    return { slowVersion: m.slowVersion, items: decoded.items, gates: decoded.gates, discovered: m.discovered && [...discovery.decode(m.discovered)] };
  });
}

test('a player session with datagrams rebuilds every frame it keeps exactly, through loss and late acknowledgements', async t => {
  // Bursts of loss: every seventh datagram and the two after it, and every fifth besides.
  const { other, client, projected, sent } = await play({ lose: i => i % 7 < 3 || i % 5 === 0, ackDelay: 3, ackEvery: 2 });
  assert.ok(projected.size > 100, `${projected.size} match frames projected`);
  assert.equal(sent, projected.size, 'one fast frame a tick');
  assert.equal(other.rawMessages.filter(m => m.type === 'state' && m.state.phase !== 'waiting').length, 0, 'no match frame goes on the stream as `state`');
  assert.equal(client.missing, 0, 'the server deltas only against frames the client acknowledged');
  assert.ok(client.kept > 40 && client.kept < projected.size, `${client.kept} frames kept of ${projected.size}`);
  assert.ok(client.deltas > client.kept * 0.8, `${client.deltas} of ${client.kept} kept frames were deltas`);
  const sentFrames = windowed(projected);
  for (const { state } of client.frames) assert.deepEqual(state, sentFrames.get(state.tick), `the fast part at tick ${state.tick}`);
  // The slow layers: a `slow` message only when they change, each with the next version, and rebuilt they are
  // what the server projected.
  const slow = slowLayers(other), last = projected.get(Math.max(...projected.keys()));
  assert.ok(slow.length >= 1 && slow.length < projected.size / 2, `${slow.length} slow messages over ${projected.size} ticks`);
  assert.deepEqual(slow.map(s => s.slowVersion), slow.map((_, i) => i + 1), 'a version per change, from one');
  assert.ok(last.self.discovered.length > 0, 'a contestant discovers');
  assert.deepEqual([slow.at(-1).items, slow.at(-1).gates, slow.at(-1).discovered.toSorted((a, b) => a - b)],
    [last.items, last.gates, last.self.discovered.toSorted((a, b) => a - b)]);
  assert.equal(client.frames.at(-1).slowVersion, slow.at(-1).slowVersion, 'the newest frame names the slow layers it was projected with');
  t.diagnostic(`kept ${client.kept} of ${projected.size} (${client.deltas} deltas); ${slow.length} slow messages; ${client.stale} late`);
});

/** The fast frames the server sends for `projected`'s views, tick by tick: each view's fast part through one event window. */
function windowed(projected) {
  const window = createEventWindow(), sent = new Map();
  for (const tick of [...projected.keys()].sort((a, b) => a - b)) {
    const { rosterRevision: _r, ...view } = projected.get(tick);
    sent.set(tick, window(fastFrame(view)));
  }
  return sent;
}

test('through bursts of loss every event reaches the client once, where the last six alone would drop some', async t => {
  // Each burst: two events a tick for five ticks, ten in all, while datagrams go missing for eight.
  const burst = i => i < 100 && i % 20 >= 5 && i % 20 < 10;
  const { other, client, projected, largest } = await play({
    lose: n => n < 100 && n % 20 >= 4 && n % 20 < 12, ackDelay: 3, ackEvery: 2,
    each: (i, room) => {
      if (!burst(i) || !room.game) return;
      const actor = participant(room.game, room.game.players[0]);
      for (let k = 0; k < 2; k++) event(room.game, { kind: 'respawned', actor });
    },
  });
  const ticks = [...projected.keys()].sort((a, b) => a - b);
  const all = [...new Set(ticks.flatMap(tick => projected.get(tick).events.map(e => e.id)))];
  assert.ok(all.length >= 40, `${all.length} events`);
  // The six-event rule: the events in the frames this client kept, had they carried only the projection's.
  const kept = client.drawn.map(frame => frame.tick);
  const lastSix = new Set(kept.flatMap(tick => projected.get(tick).events.map(e => e.id)));
  const dropped = all.filter(id => !lastSix.has(id));
  assert.ok(dropped.length > 0, 'the last six alone would have dropped some');
  // The window: each event arrives once, in order, and each frame drawn carries the events a `state` of its tick would.
  assert.deepEqual(client.arrived.map(e => e.id), all, 'every event arrives, once, in order');
  for (const frame of client.drawn) assert.deepEqual(frame.events, projected.get(frame.tick).events, `the events drawn at tick ${frame.tick}`);
  const sent = windowed(projected);
  const longest = Math.max(...ticks.map(tick => sent.get(tick).events.length));
  // `largest` counts datagrams only; a message over the limit would have gone on the stream instead.
  assert.equal(other.rawMessages.filter(m => m.type === 'fast').length, 0, 'no fast message overflowed to the stream');
  assert.ok(largest <= MAX_FAST_DATAGRAM_BYTES, `the largest fast message, ${largest} B, fits the edge's fragments`);
  t.diagnostic(`${all.length} events; the last six alone would drop ${dropped.length}; up to ${longest} in a frame; largest message ${largest} B`);
});

test('a reader draws the newest six events, each once, from frames that carry a longer window', () => {
  const e = (id, tick = id) => ({ id, tick });
  assert.equal(keptEvents([e(1)], undefined), undefined, 'a frame without events draws none');
  assert.deepEqual(keptEvents(undefined, [e(1), e(2)]), [e(1), e(2)]);
  assert.deepEqual(keptEvents([e(1), e(2)], [e(2), e(3)]), [e(1), e(2), e(3)], 'held once');
  const window = Array.from({ length: 9 }, (_, i) => e(i + 3));
  assert.deepEqual(keptEvents([e(1), e(2), e(3)], window), window.slice(-KEPT_EVENTS), 'the newest six');
  // The server's window: an event stays for the history's span after its tick, beside the projection's own.
  const win = createEventWindow(4);
  assert.deepEqual(win({ tick: 1, events: [e(1, 1)] }).events, [e(1, 1)]);
  assert.deepEqual(win({ tick: 2, events: [e(2, 2)] }).events, [e(1, 1), e(2, 2)], 'kept after the projection drops it');
  assert.deepEqual(win({ tick: 5, events: [e(5, 5)] }).events, [e(2, 2), e(5, 5)], 'until four ticks have passed');
  const frame = { tick: 9, events: [e(5, 5)] };
  assert.equal(win(frame), frame, 'nothing older kept: the frame itself');
  // The reader: arrivals per call, through a frame before any `slow`, a stale one and a paused re-send.
  const reader = createFastReader();
  const fast = (tick, events) => reader.fast({ rosterRevision: 1, slowVersion: 1, state: { tick, phase: 'live', events } });
  assert.equal(fast(10, [e(1), e(2)]), null, 'nothing drawn before the slow layers');
  assert.deepEqual(reader.arrived(), [e(1), e(2)], 'but its events have arrived');
  reader.slow([], [], 1);
  fast(12, [e(1), e(2), e(3)]);
  assert.deepEqual(reader.arrived(), [e(3)], 'each once');
  assert.equal(fast(11, [e(1), e(2)]), null);
  assert.deepEqual(reader.arrived(), [], 'a stale frame brings nothing');
  assert.deepEqual(fast(12, [e(1), e(2), e(3)]).events, [e(1), e(2), e(3)], 'a paused re-send draws the same events');
  assert.deepEqual(reader.arrived(), [], 'and brings none again');
});

test('until a frame is acknowledged every frame is whole; after, each is a delta against the newest acknowledged', async () => {
  const sent = [];
  const h = roomHarness({ reuseMaps: true });
  const made = await h.room();
  const owner = h.joined(made, { ownerKey: made.ownerKey });
  const other = h.joined(made, { role: 'gladiator' }, { datagram: bytes => { sent.push(bytes); return true; } });
  // The baselines each message asks for, given the server's own frames as the client would hold them.
  const held = new Map();
  const read = () => sent.splice(0).map(bytes => {
    const asked = [];
    const { state } = codec.decode(bytes, { baseline: tick => { asked.push(tick); return held.get(tick); } });
    held.set(state.tick, state);
    return { tick: state.tick, asked };
  });
  try {
    h.wake(50); owner.send({ type: 'start' });
    for (let i = 0; i < 6; i++) h.wake(50);
    const first = read();
    assert.ok(first.length >= 5, 'one fast frame a tick');
    assert.deepEqual(first.flatMap(m => m.asked), [], 'whole, every tick, until one is acknowledged');
    h.service.acknowledge(other.session, first[2].tick);
    h.service.acknowledge(other.session, first[0].tick); // late and older: changes nothing
    for (let i = 0; i < 3; i++) h.wake(50);
    assert.deepEqual(read().map(m => m.asked), [[first[2].tick], [first[2].tick], [first[2].tick]]);
    // A tick past the match's is no acknowledgement: it must not outrank the true ones after it.
    h.service.acknowledge(other.session, first.at(-1).tick + 10_000);
    h.wake(50);
    const after = read();
    assert.deepEqual(after.map(m => m.asked), [[first[2].tick]]);
    h.service.acknowledge(other.session, after[0].tick);
    h.wake(50);
    assert.deepEqual(read().map(m => m.asked), [[after[0].tick]]);
  } finally { await h.service.close(); }
});

test('a slow message the stream skips is sent again on the next tick, with its keyframes whole', async () => {
  const h = roomHarness({ reuseMaps: true });
  const made = await h.room();
  const owner = h.joined(made, { ownerKey: made.ownerKey, role: 'gladiator' });
  // A session whose stream skips the first `slow` it is offered, as a backed-up one does.
  const slow = [];
  let skip = true;
  const session = h.service.connect({
    deliver: payload => {
      if (typeof payload === 'string') return true;
      const message = codec.decode(payload);
      if (message.type !== 'slow') return true;
      if (skip) { skip = false; return false; }
      slow.push(message); return true;
    },
    datagram: () => true,
    close: () => {},
  });
  h.directory.receive(session, { type: 'join', room: made.id, role: 'contestant' });
  try {
    h.wake(50); owner.send({ type: 'start' });
    h.wake(50);
    assert.equal(skip, false, 'the first was offered and skipped');
    assert.equal(slow.length, 1, 'and sent again on the next tick');
    assert.ok(['items', 'gates', 'discovered'].every(layer => 'all' in slow[0][layer]), 'each keyframe whole, since none was delivered');
    h.wake(50);
    assert.ok(slow.length <= 2, 'after that, only when the layers change');
  } finally { await h.service.close(); }
});

test('the delivery condition: a shared view, no datagrams, or a JSON session gets today\'s state', () => {
  const player = { playerId: 'p1', datagrams: true, stateEncoding: 'binary' };
  assert.equal(deliversFast(player), true);
  assert.equal(deliversFast({ ...player, playerId: null, dev: true }), false, 'the dev view');
  assert.equal(deliversFast({ ...player, playerId: null }), false, 'a delayed spectator');
  assert.equal(deliversFast({ ...player, datagrams: false }), false, 'no datagrams');
  assert.equal(deliversFast({ ...player, stateEncoding: 'json' }), false, 'a JSON session');
});

test('the history keeps 32 ticks, and a tick sent twice is never a baseline', () => {
  const history = createFastHistory();
  for (let tick = 1; tick <= 40; tick++) history.record(tick, { tick });
  assert.equal(history.size, FAST_HISTORY_TICKS);
  assert.equal(history.get(8), undefined);
  assert.deepEqual(history.get(9), { tick: 9 });
  // A paused room re-sends its tick after a dev teleport: the reader may hold either frame.
  history.record(40, { tick: 40, moved: true });
  assert.equal(history.get(40), undefined);
  assert.deepEqual(history.get(39), { tick: 39 });
});

test('the item-body hold leaves out a body whose item the reader lacks, and any tether to it', () => {
  const frame = {
    tick: 5,
    bodies: [{ id: 1, owner: { kind: 'actor', playerIdx: 0 } }, { id: 2, owner: { kind: 'item', itemId: 7 } }, { id: 3, owner: { kind: 'item', itemId: 8 } }],
    tethers: [{ id: 1, a: 1, b: 2 }, { id: 2, a: 1, b: 3 }],
  };
  assert.equal(holdItemBodies(frame, () => true), frame, 'nothing held back: the frame itself');
  const held = holdItemBodies(frame, itemId => itemId === 8);
  assert.deepEqual(held.bodies.map(b => b.id), [1, 3]);
  assert.deepEqual(held.tethers.map(t => t.id), [2]);
  assert.equal(frame.bodies.length, 3, 'the rebuilt frame, the reader\'s baseline, is unchanged');
});

test('the reader keeps only newer frames, draws with the slow layers it holds, and holds back bodies of items it lacks', () => {
  const reader = createFastReader();
  const frame = (tick, extra = {}, slowVersion = 1) => ({ rosterRevision: 1, slowVersion, state: { tick, phase: 'live', bodies: [{ id: 1, owner: { kind: 'item', itemId: 7 } }], ...extra } });
  assert.equal(reader.fast(frame(10)), null, 'nothing is drawn before the slow layers arrive');
  assert.equal(reader.newest(), 10, 'but the frame is held and acknowledged');
  assert.equal(reader.baseline(10).tick, 10);
  assert.equal(reader.slow([{ id: 8 }], [{ id: 'g' }], 1).tick, 10, 'the held frame is drawn once they do');
  const drawn = reader.fast(frame(11));
  assert.deepEqual(drawn.bodies, [], 'item 7 is not held, so its body waits');
  assert.deepEqual([drawn.items, drawn.gates, drawn.rosterRevision], [[{ id: 8 }], [{ id: 'g' }], 1]);
  assert.equal(reader.baseline(11).bodies.length, 1, 'the baseline is the frame as rebuilt, not as drawn');
  assert.equal(reader.fast(frame(9)), null, 'an older frame is ignored');
  assert.equal(reader.newest(), 11);
  assert.equal(reader.slow([{ id: 8 }], [], 1), null, 'the newest was drawn with the layers it names: no redraw');
  // A frame projected with layers the stream has not yet brought: drawn now, and again when they arrive, since
  // after a pause or the match's end no frame may follow them.
  assert.equal(reader.fast(frame(12, {}, 2)).bodies.length, 0);
  const redrawn = reader.slow([{ id: 7 }], [], 2);
  assert.deepEqual([redrawn.tick, redrawn.bodies.length], [12, 1], 'item 7 arrived with the layers frame 12 names');
  assert.equal(reader.slow([{ id: 7 }], [], 3), null, 'a later version than the newest frame names: no redraw');
  assert.equal(reader.current().tick, 12, 'what a reader waiting on a roster would draw');
  // A paused room re-sends its tick after a dev teleport: drawn, but no longer a baseline.
  const again = reader.fast(frame(12, { moved: true }, 3));
  assert.equal(again.moved, true);
  assert.equal(reader.baseline(12), undefined);
  // A `slow` skipped under backlog is re-sent at the current version: one past the frame's version still draws it.
  reader.fast(frame(13, {}, 4));
  assert.equal(reader.slow([{ id: 7 }], [], 5).tick, 13, 'version 4 was skipped; 5 completes frame 13');
});

test("a fast message over the edge's four fragments goes on the stream; its deltas, which fit, on datagrams", async () => {
  const h = roomHarness({ reuseMaps: true });
  const made = await h.room();
  const owner = h.joined(made, { ownerKey: made.ownerKey, role: 'gladiator' });
  const reader = createFastReader(), streamed = [], datagrams = [];
  const read = (bytes, into) => {
    const message = codec.decode(bytes, { baseline: reader.baseline });
    if (message.type !== 'fast') return;
    into.push({ bytes: bytes.length, tick: message.state.tick });
    reader.fast(message);
  };
  const session = h.service.connect({
    deliver: payload => { if (typeof payload !== 'string') read(payload, streamed); return true; },
    datagram: bytes => { read(bytes, datagrams); return true; },
    close: () => {},
  });
  h.directory.receive(session, { type: 'join', room: made.id, role: 'contestant' });
  // A bigger roster or map than this arena's: the contestant's view gains props until a whole frame needs more
  // than four of the edge's fragments. They do not move, so a delta against an acknowledged frame stays small.
  const project = made.match.project;
  made.match.project = (frame, id) => {
    const view = project(frame, id);
    if (id !== session.playerId || view.phase === 'waiting' || !view.bodies?.length) return view;
    const [model] = view.bodies;
    const props = Array.from({ length: 120 }, (_, i) => ({ ...model, id: 100_000 + i, owner: { kind: 'prop', propId: 100_000 + i } }));
    return { ...view, bodies: [...view.bodies, ...props] };
  };
  try {
    h.wake(50); owner.send({ type: 'start' });
    for (let i = 0; i < 4; i++) h.wake(50);
    assert.ok(streamed.length >= 3 && datagrams.length === 0, `${streamed.length} whole frames streamed, ${datagrams.length} sent as datagrams`);
    assert.ok(streamed.every(m => m.bytes > MAX_FAST_DATAGRAM_BYTES), 'each over the limit');
    h.service.acknowledge(session, reader.newest());
    for (let i = 0; i < 3; i++) h.wake(50);
    assert.equal(datagrams.length, 3, 'deltas against the acknowledged frame fit');
    assert.ok(datagrams.every(m => m.bytes <= MAX_FAST_DATAGRAM_BYTES));
  } finally { await h.service.close(); }
});

test('the fast part rounds only the fields prediction does not collide with, so a change within a quantum sends nothing', () => {
  const self = { x: 10.123456, y: 4.987654, heading: 0.1234567 }, body = { id: 1, x: 10.123456, y: 4.987654, angle: 0.3 };
  const view = { tick: 9, self, bodies: [body], items: [], gates: [],
    players: [{ playerIdx: 2, heading: 1000.1 * ANGLE_QUANTUM, x: 3.14159 }], projectiles: [{ id: 4, x: 1.3, y: -2.7, dx: 0.33333, dy: -0.1, life: 3 }],
    effects: [{ id: 5, x: 7.77777, y: 8.88888, radius: 1.2345, life: 4 }], hookFlights: [{ id: 6, a: 1, casterIdx: 2, x: 5.55555, y: -6.66666 }],
    traps: [{ id: 't', kind: 'turret', x: 1.111, y: 2.5, homeX: 2.222, homeY: -3.333, heading: -0.5555, offset: 0.123 }] };
  const fast = fastFrame(view);
  assert.equal(fast.self, self, 'the viewer\'s own record is exact, the projection\'s own');
  assert.equal(fast.bodies[0], body, 'every body is exact');
  assert.equal(view.players[0].heading, 1000.1 * ANGLE_QUANTUM, 'the view keeps its exact values');
  for (const [list, quanta] of Object.entries(FAST_QUANTA)) for (const [i, record] of (fast[list] ?? []).entries()) {
    for (const [field, value] of Object.entries(record)) {
      const exact = view[list][i][field];
      if (field in quanta) {
        assert.equal(value, quantize(exact, quanta[field]), `${list}.${field} is rounded`);
        assert.ok(Math.abs(value - exact) <= quanta[field] / 2, `${list}.${field} within half a quantum`);
      } else assert.equal(value, exact, `${list}.${field} is exact`);
    }
  }
  assert.equal(fast.effects[0].radius, 1.2345, 'radius is exact (24.1)');
  assert.ok(Number.isNaN(quantize(NaN, ANGLE_QUANTUM)), 'a bad value stays bad, for the codec to refuse, never 0');
  assert.deepEqual(Object.keys(FAST_QUANTA).filter(list => !fast[list]?.length), [], 'every rounded list is exercised');
  // Every rounded list, through the live schema's fast records: the frame rebuilds exactly as rounded.
  const codec = wireCodec(), state = { tick: 9, phase: 'live', hazardX: 0, slots: 0, contestantsActive: 1,
    players: [{ playerIdx: 2, heading: fast.players[0].heading, status: 'active', hp: 100, maxHp: 100, shield: 0, weapon: 1, cloak: 0, revealed: 0, x: fast.players[0].x, y: 0 }],
    traps: fast.traps, projectiles: [{ ...fast.projectiles[0], owner: 'p', damage: 5 }], effects: [{ ...fast.effects[0], kind: EFFECT_KINDS[0] }], hookFlights: fast.hookFlights };
  const sent = { type: 'fast', rosterRevision: 1, slowVersion: 1, state };
  assert.deepEqual(codec.decode(codec.encode(sent)), sent);
  assert.throws(() => codec.encode({ ...sent, state: { ...state, hookFlights: view.hookFlights } }), /not on the grid/, 'an unrounded value is refused');
  // A heading moving within its quantum is no change (fast-delta.test.js rebuilds real rounded frames through the schema).
  const nudged = fastFrame({ ...view, players: [{ ...view.players[0], heading: view.players[0].heading + ANGLE_QUANTUM / 8 }] });
  assert.deepEqual(nudged.players, fast.players);
});
