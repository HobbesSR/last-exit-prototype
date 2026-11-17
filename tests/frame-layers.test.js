import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerEncoder, createLayerDecoder } from '../shared/frame-layers.ts';
import { createMatch } from '../server/match.js';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { readServerMessage } from '../shared/wire-schema.ts';

// What one session is sent of an encoded frame: the keyframe when it lacks it, else the changes.
function wire(encoded, frame, held) {
  const out = { ...frame };
  for (const [layer, e] of Object.entries(encoded)) {
    if ('plain' in e) { out[layer] = e.plain; continue; }
    out[layer] = held[layer] === e.k ? e.changes : e.all();
    held[layer] = e.k;
  }
  return JSON.parse(JSON.stringify(out));
}

test('a directed view rebuilds exactly from keyframes and changes, at a fraction of its size (#250)', async () => {
  // On the pregenerated arena (#849): the encoding, not the map, is under test.
  const match = await createMatch(9, undefined, generatedMap(9)), encoder = createLayerEncoder(), decoder = createLayerDecoder(), held = {};
  let whole = 0, sent = 0, keyframes = 0;
  try {
    for (let tick = 0; tick < 300; tick++) {
      const view = match.project(match.advance(), null), encoded = encoder.encode(view);
      const payload = wire(encoded, view, held);
      if ('all' in payload.items) keyframes++;
      // Only the layered lists: the rest goes whole either way, so a whole-frame ratio would measure the map's item count.
      for (const layer of Object.keys(encoded)) { whole += JSON.stringify(view[layer]).length; sent += JSON.stringify(payload[layer]).length; }
      assert.deepEqual(decoder.decode(payload), JSON.parse(JSON.stringify(view)), `tick ${tick}`);
    }
    assert.ok(sent < whole / 10, `sent ${sent} of ${whole} bytes`);
    assert.ok(keyframes < 10, `${keyframes} item keyframes`);
  } finally { match.dispose(); }
});

test('a layer is rekeyed when its changes outgrow the budget or its order would not rebuild', () => {
  const encoder = createLayerEncoder(), items = Array.from({ length: 64 }, (_, id) => ({ id, x: 0 }));
  const first = encoder.encode({ items }).items;
  const few = encoder.encode({ items: items.map((item, i) => i < 3 ? { ...item, x: 1 } : item) }).items;
  assert.equal(few.k, first.k); assert.deepEqual(few.changes.set.map(i => i.id), [0, 1, 2]);
  const dropped = encoder.encode({ items: items.slice(1) }).items;
  assert.equal(dropped.k, first.k); assert.deepEqual(dropped.changes.drop, [0]);
  assert.notEqual(encoder.encode({ items: items.map(item => ({ ...item, x: 2 })) }).items.k, first.k, 'too many changes');
  const swapped = [items[1], items[0], ...items.slice(2)];
  const k = encoder.encode({ items }).items.k;
  assert.notEqual(encoder.encode({ items: swapped }).items.k, k, 'a reorder the decoder would not reproduce');
  assert.deepEqual(encoder.encode({ items: [{ id: 1 }, { id: 1 }] }).items, { plain: [{ id: 1 }, { id: 1 }] }, 'ids that are not distinct go whole');
});

test('a session given a keyframe late rebuilds every later frame, including a return to the keyframe (#269 review)', () => {
  const encoder = createLayerEncoder(), closed = { id: 'door-28', open: false }, other = { id: 'door-29', open: false };
  const frames = [[closed, other], [{ ...closed, open: true }, other], [{ ...closed, open: true }], [closed, other]];
  // `early` from the first frame; `late` joins at the second; `delayed` misses the first two, as after skips.
  const sessions = { early: 0, late: 1, delayed: 2 };
  const held = Object.fromEntries(Object.keys(sessions).map(name => [name, {}]));
  const decoders = Object.fromEntries(Object.keys(sessions).map(name => [name, createLayerDecoder()]));
  let k;
  frames.forEach((gates, i) => {
    const encoded = encoder.encode({ gates });
    k ??= encoded.gates.k;
    assert.equal(encoded.gates.k, k, 'one keyframe throughout');
    for (const [name, from] of Object.entries(sessions)) {
      if (i < from) continue;
      const decoded = decoders[name].decode(wire(encoded, { gates }, held[name]));
      assert.deepEqual(decoded.gates, gates, `${name}, frame ${i}`); assert.equal(decoded.stale, undefined);
    }
  });
});

test('changes against a keyframe the decoder lacks keep the last list and say which layer is stale', () => {
  const decoder = createLayerDecoder();
  const gates = [{ id: 'a', open: false }];
  assert.deepEqual(decoder.decode({ gates: { k: 1, all: gates } }).gates, gates);
  const stale = decoder.decode({ gates: { k: 2, set: [{ id: 'a', open: true }] } });
  assert.deepEqual(stale.gates, gates); assert.deepEqual(stale.stale, ['gates']);
  assert.deepEqual(decoder.decode({ gates: [{ id: 'b' }] }).gates, [{ id: 'b' }], 'a plain list passes through');
});

test('a session is sent the keyframe after a skipped frame, while others keep sharing changes', async () => {
  const h = roomHarness({ devTools: 'all', reuseMaps: true }), { room } = await h.live();
  try {
    const watcher = () => {
      const sizes = [], frames = [], keyed = [], decoder = createLayerDecoder(); let skip = false;
      const session = h.service.connect({ close() {}, deliver(payload, droppable) {
        if (skip && droppable) return false;
        const data = readServerMessage(payload);
        if (data.type === 'state') { sizes.push(payload.length); keyed.push('all' in data.state.items); frames.push(decoder.decode(data.state)); }
        return true;
      } });
      h.service.receive(session, { type: 'join', room: room.id, mode: 'dev' });
      return { sizes, frames, keyed, skipping: on => { skip = on; } };
    };
    const a = watcher(), b = watcher();
    for (let i = 0; i < 5; i++) h.wake(50);
    assert.ok(a.sizes[0] > a.sizes.at(-1) * 5, `first frame carries the keyframes: ${a.sizes[0]} then ${a.sizes.at(-1)}`);
    // Force a new keyframe while `a` is skipping: it must be sent it whole when it next receives.
    a.skipping(true);
    room.layerEncoders.get('dev').encode({ items: [] }); h.wake(50);
    a.skipping(false); h.wake(50);
    assert.ok(a.keyed.at(-1) && !b.keyed.at(-1), 'the session that missed the keyframe gets it whole; the other gets changes');
    const truth = room.match.project(room.match.snapshot(), null);
    assert.deepEqual(a.frames.at(-1).items, truth.items); assert.equal(a.frames.at(-1).stale, undefined);
    assert.deepEqual(b.frames.at(-1).items, truth.items);
  } finally { await h.service.close(); }
});

test('gate layers address canonical map slots, including zero, and retain legacy id support (#1153)', () => {
  const encoder = createLayerEncoder(), decoder = createLayerDecoder(), held = {};
  const gates = [{ gateIdx: 0, open: false }, { gateIdx: 3, open: false }];
  const first = encoder.encode({ gates });
  assert.deepEqual(decoder.decode(wire(first, { gates }, held)).gates, gates);
  const changed = [{ gateIdx: 0, open: true }], next = encoder.encode({ gates: changed });
  assert.equal(next.gates.k, first.gates.k);
  assert.deepEqual(next.gates.changes.set, [changed[0]]);
  assert.deepEqual(next.gates.changes.drop, [3]);
  assert.deepEqual(decoder.decode(wire(next, { gates: changed }, held)).gates, changed);
});

test('body shape deltas use the target keyframe across joins, skips, visibility and generations (#1153)', () => {
  const encoder = createLayerEncoder();
  const body = { id: 1, generation: 1, shape: { kind: 'circle', radius: 1 }, x: 0 };
  const spawned = { id: 2, generation: 1, shape: { kind: 'box', width: 2, height: 3 }, x: 0 };
  const regenerated = { ...body, generation: 2, shape: { kind: 'circle', radius: 2 }, x: 3 };
  const frames = [
    [body],
    [{ ...body, x: 1 }, spawned],
    [{ ...body, x: 2 }, { ...spawned, x: 1 }],
    [regenerated, { ...spawned, x: 2 }],
    [{ ...spawned, x: 3 }],
    [{ ...body, x: 4 }, { ...spawned, x: 4 }],
    [body],
  ];
  const sessions = { early: { from: 0 }, late: { from: 2 }, skipped: { from: 0, skip: new Set([1, 3, 4]) } };
  for (const session of Object.values(sessions)) Object.assign(session, { decoder: createLayerDecoder(), held: {} });
  let k;
  frames.forEach((bodies, i) => {
    const encoded = encoder.encode({ bodies }), layer = encoded.bodies;
    k ??= layer.k;
    assert.equal(layer.k, k, 'the original keyframe remains the target');
    const all = layer.all();
    assert.deepEqual(all.all, [body], 'keyframe always retains its complete shapes');
    for (const entry of layer.changes.set ?? []) {
      assert.equal(Object.hasOwn(entry, 'shape'), entry.id !== body.id || entry.generation !== body.generation,
        `frame ${i}, body ${entry.id}: only the exact baseline admission can omit its shape`);
    }
    for (const [name, session] of Object.entries(sessions)) {
      if (i < session.from || session.skip?.has(i)) continue;
      const payload = wire(encoded, { bodies }, session.held);
      if (name === 'late' && i === session.from) {
        assert.ok(payload.bodies.all && payload.bodies.set, 'late join carries baseline plus current changes');
      }
      assert.deepEqual(session.decoder.decode(payload).bodies, bodies, `${name}, frame ${i}`);
    }
  });
  // Absorption into a new keyframe is the point when a spawned shape may stop repeating.
  const crowded = [body, spawned, ...Array.from({ length: 17 }, (_, n) => ({ ...body, id: n + 3 }))];
  const rekeyed = encoder.encode({ bodies: crowded }).bodies;
  assert.notEqual(rekeyed.k, k);
  assert.ok(rekeyed.all().all.every(entry => Object.hasOwn(entry, 'shape')));
  const moved = encoder.encode({ bodies: crowded.map(entry => entry.id === spawned.id ? { ...entry, x: 8 } : entry) }).bodies;
  assert.equal(moved.k, rekeyed.k);
  assert.equal(Object.hasOwn(moved.changes.set[0], 'shape'), false);
});

test('body shape reconstruction reads the immutable baseline rather than the previous generation (#1153)', () => {
  const decoder = createLayerDecoder();
  const firstShape = { kind: 'circle', radius: 1 }, secondShape = { kind: 'circle', radius: 2 };
  decoder.decode({ bodies: { k: 1, all: [{ id: 1, generation: 1, shape: firstShape, x: 0 }] } });
  decoder.decode({ bodies: { k: 1, set: [{ id: 1, generation: 2, shape: secondShape, x: 1 }] } });
  const restored = decoder.decode({ bodies: { k: 1, set: [{ id: 1, generation: 1, x: 2 }] } });
  assert.deepEqual(restored.bodies, [{ id: 1, generation: 1, x: 2, shape: firstShape }]);
  const unknown = decoder.decode({ bodies: { k: 1, set: [{ id: 1, generation: 2, x: 3 }] } });
  assert.equal(Object.hasOwn(unknown.bodies[0], 'shape'), false, 'a missing new-generation shape cannot be borrowed');
});
