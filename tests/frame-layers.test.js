import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerEncoder, createLayerDecoder } from '../shared/frame-layers.ts';
import { createMatch } from '../server/match.js';
import { roomHarness } from './helpers/room-harness.js';

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

test('a directed view rebuilds exactly from keyframes and changes, at a fraction of its size (#250)', () => {
  const match = createMatch(4217), encoder = createLayerEncoder(), decoder = createLayerDecoder(), held = {};
  let whole = 0, sent = 0, keyframes = 0;
  for (let tick = 0; tick < 300; tick++) {
    const view = match.project(match.advance(), null), encoded = encoder.encode(view);
    const payload = wire(encoded, view, held);
    if ('all' in payload.items) keyframes++;
    whole += JSON.stringify(view).length; sent += JSON.stringify(payload).length;
    assert.deepEqual(decoder.decode(payload), JSON.parse(JSON.stringify(view)), `tick ${tick}`);
  }
  assert.ok(sent < whole / 10, `sent ${sent} of ${whole} bytes`);
  assert.ok(keyframes < 10, `${keyframes} item keyframes`);
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

test('a session is sent the keyframe after a skipped frame, while others keep sharing changes', () => {
  const h = roomHarness({ devTools: 'all' }), { room } = h.live();
  try {
    const watcher = () => {
      const sizes = [], frames = [], decoder = createLayerDecoder(); let skip = false;
      const session = h.service.connect({ close() {}, deliver(payload, droppable) {
        if (skip && droppable) return false;
        const data = JSON.parse(payload);
        if (data.type === 'state') { sizes.push(payload.length); frames.push(decoder.decode(data.state)); }
        return true;
      } });
      h.service.receive(session, { type: 'join', room: room.id, role: 'dev' });
      return { sizes, frames, skipping: on => { skip = on; } };
    };
    const a = watcher(), b = watcher();
    for (let i = 0; i < 5; i++) h.wake(50);
    assert.ok(a.sizes[0] > a.sizes.at(-1) * 5, `first frame carries the keyframes: ${a.sizes[0]} then ${a.sizes.at(-1)}`);
    // Force a new keyframe while `a` is skipping: it must be sent it whole when it next receives.
    a.skipping(true);
    room.layerEncoders.get('dev').encode({ items: [] }); h.wake(50);
    a.skipping(false); h.wake(50);
    assert.ok(a.sizes.at(-1) > b.sizes.at(-1) * 5, 'the session that missed the keyframe gets it whole');
    const truth = room.match.project(room.match.snapshot(), null);
    assert.deepEqual(a.frames.at(-1).items, truth.items); assert.equal(a.frames.at(-1).stale, undefined);
    assert.deepEqual(b.frames.at(-1).items, truth.items);
  } finally { return h.service.close(); }
});
