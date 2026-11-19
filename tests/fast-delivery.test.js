import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { wireCodec } from '../shared/wire-schema.ts';
import { MissingBaseline } from '../shared/wire-codec.ts';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { createDiscoveryDecoder } from '../shared/discovery.ts';
import { createFastHistory, fastFrame, holdItemBodies, FAST_HISTORY_TICKS } from '../shared/fast-state.ts';
import { deliversFast } from '../server/room-views.js';

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
 * holds what the server projected for the contestant at each tick, as the room's history would.
 */
async function play({ lose = () => false, ackDelay = 2, ackEvery = 1 } = {}) {
  const h = roomHarness({ reuseMaps: true });
  const made = await h.room();
  const received = [], acks = [], projected = new Map();
  let count = 0;
  const owner = h.joined(made, { ownerKey: made.ownerKey, role: 'gladiator' });
  const other = h.joined(made, { role: 'contestant' }, { datagram: bytes => { if (!lose(count++)) received.push(bytes); return true; } });
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
    return { other, client, projected, sent: count };
  } finally { await h.service.close(); }
}

/** The client's side, as the next PR's apply will be: it keeps the frames it rebuilt and applies only newer ones. */
function fakeClient() {
  const held = createFastHistory(), frames = [];
  let newest = -1;
  const client = {
    frames, kept: 0, missing: 0, stale: 0, deltas: 0,
    /** Applies one datagram; the tick it now holds as newest, or null when it applied nothing. */
    receive(bytes) {
      let message;
      let delta = false;
      try { message = codec.decode(bytes, { baseline: tick => { delta = true; return held.get(tick); } }); } catch (error) {
        if (error instanceof MissingBaseline) { client.missing++; return null; }
        throw error;
      }
      const { state } = message;
      if (state.tick <= newest) { client.stale++; return null; }
      newest = state.tick; held.record(state.tick, state); client.kept++; if (delta) client.deltas++;
      frames.push(message);
      return newest;
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
  for (const { state } of client.frames) {
    const { rosterRevision: _r, ...view } = projected.get(state.tick);
    assert.deepEqual(state, fastFrame(view), `the fast part at tick ${state.tick}`);
  }
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
    // An acknowledgement the history no longer holds, or never held, gets whole frames again.
    h.service.acknowledge(other.session, first.at(-1).tick + 10_000);
    h.wake(50);
    assert.deepEqual(read().map(m => m.asked), [[]]);
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
