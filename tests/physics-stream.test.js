import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast, remember, viewEncoders, SPECTATOR_DELAY_TICKS } from '../server/room-views.js';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const body = (id, x = 0, extra = {}) => ({ id, kind: 'prop', shape: { kind: 'circle', radius: 6 }, x, y: 0, angle: 0, vx: 0, vy: 0, omega: 0, sleeping: false, generation: 1, ...extra });
const frame = (tick, bodies, tethers = []) => ({ tick, physicsProfile: 'test-profile', players: [], items: [], gates: [], bodies, tethers });

function watcher(room) {
  const decoder = createLayerDecoder(), received = [], wire = [];
  let skip = false;
  const session = { dev: true, layerKeys: {}, deliver(payload, droppable) {
    if (skip && droppable) return false;
    const message = JSON.parse(payload);
    wire.push(structuredClone(message.state));
    received.push(decoder.decode(message.state));
    return true;
  } };
  room.clients.add(session);
  return { received, wire, session, skipping(value) { skip = value; } };
}

function roomAt(initial) {
  const room = { clients: new Set(), history: [], ...viewEncoders(),
    match: { tick: initial.tick, snapshot: () => initial, project: state => state } };
  return { room, send(state) { room.match.tick = state.tick; remember(room, state); broadcast(room, state); } };
}

test('body and tether layers rebuild moving, sleeping, changed, deleted and late-joined state', () => {
  const first = frame(0, [body('a'), body('b')], [{ id: 'rope', a: 'a', b: 'b' }, { id: 'other-rope', a: 'a', b: 'b' }]);
  first.items = [{ id: 'loot', x: 0, y: 2, angle: 0 }];
  const { room, send } = roomAt(first), early = watcher(room);
  send(first);
  assert.ok('all' in early.wire[0].bodies);
  assert.ok('all' in early.wire[0].tethers);
  const moved = frame(1, [body('a', 20, { angle: 1, vx: 4, omega: 0.5 }), body('b', 0, { sleeping: true })], first.tethers);
  moved.items = [{ id: 'loot', x: 24, y: 8, angle: 0.75 }];
  send(moved);
  assert.equal(early.wire[1].bodies.all, undefined);
  assert.deepEqual(early.received[1].bodies, moved.bodies);
  assert.deepEqual(early.wire[1].items.set, moved.items, 'position and angle invalidate the item layer');
  assert.deepEqual(early.received[1].items, moved.items);
  const late = watcher(room);
  const unchanged = frame(2, moved.bodies, moved.tethers);
  unchanged.items = moved.items;
  send(unchanged);
  assert.ok('all' in late.wire[0].bodies, 'late session receives a full body keyframe');
  assert.deepEqual(late.received[0].bodies, moved.bodies);
  assert.deepEqual(late.received[0].items, moved.items);
  early.skipping(true);
  send(frame(3, [body('a', 30, { generation: 2, discontinuity: 'placed' })]));
  early.skipping(false);
  send(frame(4, [body('a', 40, { generation: 2, sleeping: true })]));
  assert.deepEqual(early.received.at(-1).bodies, [body('a', 40, { generation: 2, sleeping: true })]);
  assert.deepEqual(early.received.at(-1).tethers, []);
  assert.deepEqual(late.received.at(-1).bodies, early.received.at(-1).bodies);
  assert.equal(early.received.at(-1).stale, undefined);
  assert.equal(late.received.at(-1).stale, undefined);
});

test('missed rekey sends whole body and tether tables and replacement room cannot reuse old keys', () => {
  const first = frame(0, [body('a'), body('b')], [{ id: 'rope', a: 'a', b: 'b' }, { id: 'other-rope', a: 'a', b: 'b' }]);
  const host = roomAt(first), peer = watcher(host.room);
  host.send(first);
  peer.skipping(true);
  // Reordering requires a new table; the session never receives these new keys.
  host.send(frame(1, [body('b'), body('a')], [{ id: 'other-rope', a: 'a', b: 'b' }, { id: 'rope', a: 'a', b: 'b' }]));
  peer.skipping(false);
  host.send(frame(2, [body('b', 9), body('a')], [{ id: 'other-rope', a: 'a', b: 'b' }, { id: 'rope', a: 'a', b: 'b' }]));
  assert.ok('all' in peer.wire.at(-1).bodies);
  assert.ok('all' in peer.wire.at(-1).tethers);
  assert.deepEqual(peer.received.at(-1).bodies.map(b => b.id), ['b', 'a']);
  assert.equal(peer.received.at(-1).stale, undefined);

  const replacement = roomAt(frame(0, [body('replacement')]));
  host.room.clients.delete(peer.session);
  replacement.room.clients.add(peer.session);
  replacement.send(frame(0, [body('replacement')]));
  assert.ok('all' in peer.wire.at(-1).bodies);
  assert.deepEqual(peer.received.at(-1).bodies.map(b => b.id), ['replacement']);
  assert.equal(peer.received.at(-1).stale, undefined);
});

test('spectator projects the retained tick while a dev viewer receives the present tick', () => {
  const past = frame(0, [body('past')]), host = roomAt(past);
  const dev = watcher(host.room), delayed = watcher(host.room);
  delayed.session.dev = false;
  host.send(past);
  for (let tick = 1; tick <= SPECTATOR_DELAY_TICKS + 1; tick++) host.send(frame(tick, [body(`present-${tick}`)]));
  assert.equal(dev.received.at(-1).bodies[0].id, `present-${SPECTATOR_DELAY_TICKS + 1}`);
  assert.equal(delayed.received.at(-1).bodies[0].id, 'present-1');
  assert.notEqual(delayed.received.at(-1).bodies[0].id, dev.received.at(-1).bodies[0].id);
});

test('bounded writer drops an oversized physics frame and hashes only retained complete frames', async () => {
  const chunks = [], header = { id: 'physics-heavy', schema: 10, minSchema: 10 };
  const writer = createReplayWriter({ header, queueBytes: 800,
    output: new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }),
    publish: async () => {}, onError: error => { throw error; } });
  const retained = [
    { state: frame(0, [body('a', 1)]), commands: [] },
    { state: frame(2, [body('a', 2, { sleeping: true })]), commands: [] },
  ];
  assert.equal(writer.append(retained[0].state, []), true);
  assert.equal(writer.append(frame(1, Array.from({ length: 128 }, (_, i) => body(`body-${i}`, i))), []), false);
  assert.equal(writer.append(retained[1].state, []), true);
  const meta = await writer.finish({ ticks: 2 });
  const archive = JSON.parse(gunzipSync(Buffer.concat(chunks)));
  assert.deepEqual(archive.frames, retained);
  assert.deepEqual(archive.recording, { complete: false, droppedFrames: 1, endTick: 2 });
  assert.deepEqual(meta.recording, archive.recording);
  const expected = createHash('sha256');
  for (const entry of retained) expected.update(`${JSON.stringify(entry)}\n`);
  assert.equal(meta.sha256, expected.digest('hex'));
});

test('body-heavy replay publication failure reports once without a successful archive', async () => {
  const chunks = [], attempted = [], errors = [];
  const heavy = { state: frame(0, Array.from({ length: 128 }, (_, i) => body(`body-${i}`, i, { angle: i / 10 }))), commands: [] };
  const writer = createReplayWriter({ header: { id: 'failed-physics', schema: 10, minSchema: 10 },
    output: new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }),
    publish: async meta => { attempted.push(meta); throw new Error('metadata unavailable'); },
    onError: error => errors.push(error.message) });
  assert.equal(writer.append(heavy.state, heavy.commands), true);
  await assert.rejects(writer.finish({ ticks: 0 }), /metadata unavailable/);
  assert.deepEqual(errors, ['metadata unavailable']);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(chunks))).frames, [heavy]);
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].frames, 1);
  assert.equal(attempted[0].sha256, createHash('sha256').update(`${JSON.stringify(heavy)}\n`).digest('hex'));
  await assert.rejects(writer.finish({ ticks: 0 }), /metadata unavailable/);
  assert.deepEqual(errors, ['metadata unavailable'], 'repeat finish does not duplicate the failure report');
});
