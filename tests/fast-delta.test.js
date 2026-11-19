import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { wireCodec } from '../shared/wire-schema.ts';
import { against, createDescriptorCodec, FORMAT, MissingBaseline } from '../shared/wire-codec.ts';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { fastFrame } from '../shared/fast-state.ts';

// The codec's deltas (24.5 stage 3, wire-codec.ts "Deltas"): a player view's fast part, written as changes
// against an earlier frame the reader holds, rebuilds that frame exactly. fast-delivery.test.js covers sending it.

const codec = wireCodec();
const HISTORY = 32; // 24.2 "Acknowledgement and baselines"

// Each player's match frames from one short room, as the client holds them: layers rebuilt, then split.
let views;
async function playerViews() {
  if (views) return views;
  const h = roomHarness({ reuseMaps: true }), made = await h.room();
  const owner = h.joined(made, { ownerKey: made.ownerKey }), other = h.joined(made, { role: 'gladiator' });
  try {
    h.wake(50);
    owner.send({ type: 'start' });
    for (let i = 0; i < 120; i++) {
      h.wake(50);
      // Some input, so poses, headings and sequence numbers move.
      for (const [p, n] of [[owner, i], [other, -i]]) p.send({ type: 'input', seq: i + 1, up: n % 40 < 20, left: n % 30 < 10, right: n % 30 > 20, angle: n / 10 });
    }
    views = [owner, other].map(p => {
      const layers = createLayerDecoder();
      return p.rawMessages.filter(m => m.type === 'state').map(m => layers.decode(structuredClone(m.state)))
        .filter(state => state.phase !== 'waiting').map(state => {
          const { rosterRevision, ...view } = state;
          return { rosterRevision, fast: fastFrame(view) };
        });
    });
    return views;
  } finally { await h.service.close(); }
}

const message = (rosterRevision, state) => ({ type: 'fast', rosterRevision, slowVersion: 1, state });
const holding = (id, frame) => ({ baseline: asked => (asked === id ? frame : undefined) });

test('a player view\'s fast part rebuilds exactly against any baseline in the history, and whole', async t => {
  let whole = 0, latest = 0, count = 0;
  for (const frames of await playerViews()) {
    assert.ok(frames.length > 100, `${frames.length} match frames`);
    assert.ok(frames.every(f => !('items' in f.fast) && !('gates' in f.fast) && f.fast.self?.discovered === undefined), 'the slow layers are left out');
    // The reader's copies are what it decoded, as a client keeps them, not the server's objects.
    const held = frames.map(f => codec.decode(codec.encode(message(f.rosterRevision, f.fast))).state);
    held.forEach((state, i) => assert.deepEqual(state, frames[i].fast, `whole frame ${i}`));
    for (let i = 1; i < frames.length; i++) {
      const { rosterRevision, fast } = frames[i];
      whole += codec.encode(message(rosterRevision, fast)).length;
      for (const age of [1, 2, 5, 13, HISTORY]) {
        if (age > i) break;
        const id = fast.tick - age, bytes = codec.encode(message(rosterRevision, against(id, frames[i - age].fast, fast)));
        assert.deepEqual(codec.decode(bytes, holding(id, held[i - age])), message(rosterRevision, fast), `frame ${i} against ${age} before`);
        if (age === 1) { latest += bytes.length; count++; }
      }
    }
  }
  assert.ok(latest < whole / 3, `deltas against the previous frame ${latest} B against ${whole} B whole, over ${count} frames`);
  t.diagnostic(`fast part: ${Math.round(whole / count)} B whole, ${Math.round(latest / count)} B as a delta against the previous frame`);
});

test('the changes bots rarely make rebuild exactly: drops, additions, reorders, removals and variants', async () => {
  const [frames] = await playerViews();
  const base = structuredClone(frames.findLast(f => f.fast.self && f.fast.bodies?.length > 1 && f.fast.players.length > 1).fast);
  const variants = {
    'a dropped, an added and a reordered player': s => { s.players = [{ ...s.players[1], hp: 1 }, { ...s.players[0], playerIdx: 99 }]; },
    'a body\'s shape and owner changing variant': s => { s.bodies[0] = { ...s.bodies[0], shape: { kind: 'convex', vertices: [{ x: 0, y: 0 }, { x: 4.5, y: -3 }, { x: 0.1, y: 7 }] }, owner: { kind: 'prop', propId: 3 } }; },
    'an own field gone, one added, one nested change': s => { const { heading: _h, ...self } = s.self; s.self = { ...self, respawnAt: 900, reserves: { ...self.reserves, pistol: 77 } }; },
    'a list emptied and one filled': s => { s.bodies = []; s.events = [{ id: 7, tick: 3, kind: 'match_finished' }]; },
    'an optional list gone': s => { delete s.events; delete s.hookFlights; },
    'the phase changing': s => { s.phase = 'finished'; },
    'nothing at all': () => {},
    'string keys reordered': s => { s.traps = [{ id: 'b', kind: 'mine', x: 1, y: 2, heading: 0 }, { id: 'a', kind: 'mine', x: 3, y: 4, heading: 0 }]; },
  };
  base.traps = [{ id: 'a', kind: 'mine', x: 3, y: 4, heading: 0 }, { id: 'b', kind: 'mine', x: 1, y: 2, heading: 0 }];
  for (const [why, change] of Object.entries(variants)) {
    const now = structuredClone(base); change(now);
    const bytes = codec.encode(message(1, against(5, base, now)));
    assert.deepEqual(codec.decode(bytes, holding(5, base)).state, now, why);
  }
  // Unchanged records keep the reader's objects, so what it caches by identity stays cached.
  const now = { ...base, tick: base.tick + 1 }, rebuilt = codec.decode(codec.encode(message(1, against(5, base, now))), holding(5, base)).state;
  assert.equal(rebuilt.self, base.self);
  assert.equal(rebuilt.players[0], base.players[0]);
});

test('a delta whose baseline the reader lacks is its own refusal, and a whole frame needs none', async () => {
  const [frames] = await playerViews(), [a, b] = frames.slice(-2);
  const bytes = codec.encode(message(1, against(a.fast.tick, a.fast, b.fast)));
  assert.throws(() => codec.decode(bytes), MissingBaseline);
  assert.throws(() => codec.decode(bytes, holding(a.fast.tick + 1, a.fast)), MissingBaseline);
  assert.deepEqual(codec.decode(codec.encode(message(1, b.fast))).state, b.fast);
  assert.throws(() => codec.encode(message(1, against(-1, a.fast, b.fast))), TypeError);
  assert.throws(() => codec.encode(message(1, against(1, undefined, b.fast))), TypeError);
});

test('malformed deltas are refused, never rebuilt into another frame', async () => {
  const [frames] = await playerViews();
  const samples = frames.filter((_, i) => i % 20 === 1).map((f, i, all) => i && { base: all[i - 1], now: f }).filter(Boolean);
  let seed = 1095; const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (const { base, now } of samples) {
    const bytes = codec.encode(message(1, against(9, base.fast, now.fast))), options = holding(9, base.fast);
    for (let cut = 0; cut < bytes.length; cut++) assert.throws(() => codec.decode(bytes.subarray(0, cut), options), RangeError, `cut at ${cut}`);
    for (let i = 0; i < 100; i++) {
      const bad = bytes.slice(), at = 3 + Math.floor(random() * (bad.length - 3));
      bad[at] ^= 1 + Math.floor(random() * 255);
      try {
        const decoded = codec.decode(bad, options);
        // Whatever reads is a frame the schema can write again.
        assert.deepEqual(codec.decode(codec.encode(decoded)), decoded);
      } catch (error) { assert.ok(error instanceof RangeError, `${error}`); }
    }
  }
});

// A small schema for bytes no writer produces.
const SMALL = createDescriptorCodec({ version: 1, messages: { m: { id: 1, record: 'M' } }, records: {
  M: { fields: [{ name: 'v', type: { delta: 'R' } }] },
  R: { fields: [{ name: 'a', type: 'uint' }, { name: 'b', type: 'uint', optional: true }, { name: 'list', type: { list: 'E', key: 'id' } }] },
  E: { fields: [{ name: 'id', type: 'uint' }, { name: 'n', type: 'uint' }] },
} });
const SMALL_BASE = { a: 1, b: 2, list: [{ id: 1, n: 0 }, { id: 2, n: 0 }] };
const crafted = rest => SMALL.decode(Uint8Array.from([FORMAT, 1, 1, 1, 0, ...rest]), holding(0, SMALL_BASE));

test('readers refuse changes their writers never produce', () => {
  // The record mask is 4 bits (removals, a, b, list); the removal mask 3 bits.
  assert.deepEqual(crafted([0b0010, 5]), { type: 'm', v: { ...SMALL_BASE, a: 5 } });
  assert.deepEqual(crafted([0b0001, 0b010]), { type: 'm', v: { a: 1, list: SMALL_BASE.list } });
  for (const [why, bytes] of [
    ['a bit past the fields', [0b10000]],
    ['an empty removal mask', [0b0001, 0]],
    ['a required field removed', [0b0001, 0b001]],
    ['a field both changed and removed', [0b0101, 0b010, 3]],
    ['a removal bit past the fields', [0b0001, 0b1000]],
    ['unknown list flags', [0b1000, 16]],
    ['a flagged section that is empty', [0b1000, 1, 0]],
    ['an addition of a key the baseline holds', [0b1000, 1, 1, 1, 0]],
    ['a change to a key the baseline lacks', [0b1000, 2, 1, 7, 0b10, 1]],
    ['a change that moves its key', [0b1000, 2, 1, 1, 0b10, 9]],
    ['a key both changed and dropped', [0b1000, 6, 1, 1, 0b100, 1, 1, 1]],
    ['a drop of a key the baseline lacks', [0b1000, 4, 1, 7]],
    ['an order of the wrong length', [0b1000, 8, 1, 1]],
    ['an order naming a key twice', [0b1000, 8, 2, 1, 1]],
    ['an order naming a dropped key', [0b1000, 12, 1, 2, 1, 2]],
    ['a bad delta tag', null],
  ]) {
    if (!bytes) { assert.throws(() => SMALL.decode(Uint8Array.from([FORMAT, 1, 1, 2]), holding(0, SMALL_BASE)), /bad delta tag/, why); continue; }
    assert.throws(() => crafted(bytes), RangeError, why);
  }
});

test('the schema refuses a key it cannot address by, and a delta inside a delta', () => {
  const build = (type, extra = {}) => () => createDescriptorCodec({ version: 1, messages: { m: { id: 1, record: 'M' } }, records: {
    M: { fields: [{ name: 'v', type }] }, E: { fields: [{ name: 'id', type: 'uint', optional: true }, { name: 'f', type: 'f64' }] }, ...extra,
  } });
  assert.throws(build({ list: 'E', key: 'id' }), /required uint or str/);
  assert.throws(build({ list: 'E', key: 'f' }), /required uint or str/);
  assert.throws(build({ list: 'uint', key: 'id' }), /required uint or str/);
  assert.throws(build({ delta: 'D' }, { D: { fields: [{ name: 'x', type: { delta: 'uint' } }] } }), /delta inside a delta/);
  // However deep: inside a list, a nullable or a union variant (review 938 on PR #1197).
  assert.throws(build({ delta: 'D' }, { D: { fields: [{ name: 'x', type: { list: { nullable: { delta: 'uint' } } } }] } }), /delta inside a delta/);
  assert.throws(build({ delta: { union: 'k', variants: { a: 'D' } } }, { D: { fields: [{ name: 'x', type: { enumMap: [['p'], { delta: 'uint' }] } }] } }), /delta inside a delta/);
});

test('a whole keyed list refuses duplicate keys both ways, since it can become a baseline', () => {
  const twice = { a: 1, list: [{ id: 1, n: 0 }, { id: 1, n: 2 }] };
  assert.throws(() => SMALL.encode({ type: 'm', v: twice }), /duplicate key/);
  // Whole R: presence (b absent), a, two entries keyed 1.
  assert.throws(() => SMALL.decode(Uint8Array.from([FORMAT, 1, 1, 0, 0, 1, 2, 1, 0, 1, 2])), /duplicate list key/);
  assert.deepEqual(SMALL.decode(Uint8Array.from([FORMAT, 1, 1, 0, 0, 1, 2, 1, 0, 2, 2])), { type: 'm', v: { a: 1, list: [{ id: 1, n: 0 }, { id: 2, n: 2 }] } });
});
