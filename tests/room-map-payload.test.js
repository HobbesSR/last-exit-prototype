import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMapPayload, stringifyWithMap } from '../server/map-payload.js';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createReplayWriter } from '../server/replay-writer.js';

const item = (id, x) => Object.freeze({ id, kind: 'med', x, y: 2 });
const gate = (id, open) => Object.freeze({ id, x: 1, y: 2, w: 3, h: 4, open, locked: false, kind: 'door' });

test('prepared map serialization is byte-for-byte ordinary JSON with map and envelope order retained', async () => {
  for (const map of [undefined, null, '', false, 0, {}]) {
    const ordinary = { type: 'welcome', map, state: null };
    assert.equal(stringifyWithMap(ordinary), JSON.stringify(ordinary), 'unprepared values use ordinary JSON');
  }
  const custom = { map: {}, toJSON() { return { type: 'custom', map: this.map }; } };
  assert.equal(stringifyWithMap(custom), JSON.stringify(custom), 'custom root toJSON retains native semantics');
  const map = {
    seed: 7, generator: undefined, width: 100, height: 80,
    playableArea: { rows: ['..', 'é'], bounds: { x: 1, y: 2 } },
    modules: [], buildings: [], obstacles: [], gates: [gate('g', false)], hazards: [], gaps: [],
    stations: [], chargers: [], sensors: [], items: [item('i', 3)], traps: [], routes: [], nodes: [],
    streets: [], entry: { x: 0, y: 4 }, exit: { x: 99, y: 4 }, spawns: [],
    extension: { phrase: 'café ☃', absent: undefined }
  };
  const prepared = await prepareMapPayload(map, async () => {});
  const payloadMap = prepared.read(map, { itemsJson: JSON.stringify, gatesJson: JSON.stringify });
  const envelope = { type: 'welcome', label: '日本語', map: payloadMap, state: { tick: 0 }, tail: undefined };
  assert.equal(stringifyWithMap(envelope), JSON.stringify(envelope));
  assert.equal(stringifyWithMap(payloadMap), JSON.stringify(payloadMap));
  assert.equal(stringifyWithMap({ type: 'nested', payload: { map: payloadMap } }),
    JSON.stringify({ type: 'nested', payload: { map: payloadMap } }));
  assert.deepEqual(Object.keys(payloadMap), Object.keys(map));
  assert.equal(Object.hasOwn(payloadMap, 'generator'), true);
  assert.equal(stringifyWithMap({ type: 'ready', map: payloadMap }), JSON.stringify({ type: 'ready', map: payloadMap }));
});

test('static JSON is prepared privately; dynamic fields and extensions are fresh per read', async () => {
  const map = {
    seed: 3, width: 20, height: 10, playableArea: { rows: ['abc'], nested: { enabled: true } },
    modules: [], buildings: [], obstacles: [], gates: [gate('g', false)], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [item('i', 1)], traps: [{ id: 't', x: 2 }], routes: [], nodes: [],
    streets: [], entry: { x: 0, y: 1 }, exit: { x: 19, y: 1 }, spawns: [], physicsProps: [{ id: 'crate', x: 2, y: 3 }],
    extension: { label: 'first' }
  };
  const prepared = await prepareMapPayload(map, async () => {});
  const read = (source, publicMap = false) => prepared.read(source, { publicMap,
    itemsJson: JSON.stringify, gatesJson: JSON.stringify });
  const firstSource = { ...map, items: [item('i', 1)], gates: [gate('g', false)], traps: [{ id: 't', x: 2 }], extension: { label: 'first' } };
  const first = read(firstSource);
  const before = stringifyWithMap({ type: 'ready', map: first });

  map.playableArea.rows[0] = 'changed';
  map.physicsProps[0].x = 99;
  const next = read({ ...map, items: [item('i', 8)], gates: [gate('g', true)], traps: [{ id: 't', x: 9 }], extension: { label: 'second' } });
  const after = stringifyWithMap({ type: 'ready', map: next });
  assert.notEqual(after, before);
  assert.equal(stringifyWithMap({ type: 'ready', map: first }), before);
  assert.equal(first.playableArea.rows[0], 'abc');
  assert.equal(next.playableArea.rows[0], 'abc');
  assert.equal(next.items[0].x, 8);
  assert.equal(next.gates[0].open, true);
  assert.equal(next.traps[0].x, 9);
  assert.equal(next.extension.label, 'second');
  assert.throws(() => { next.playableArea.rows[0] = 'no'; }, TypeError);
  assert.throws(() => { next.items[0].x = 100; }, TypeError);
  assert.throws(() => { next.gates[0].open = false; }, TypeError);
  assert.throws(() => { next.traps[0].x = 100; }, TypeError);

  const publicView = read({ ...map, items: [item('i', 2)], gates: [gate('g', false)], traps: [] }, true);
  const recording = read({ ...map, items: [item('i', 2)], gates: [gate('g', false)], traps: [{ id: 't' }] });
  assert.equal(Object.hasOwn(publicView, 'physicsProps'), false);
  assert.equal(Object.hasOwn(recording, 'physicsProps'), true);
  assert.equal(Object.hasOwn(publicView, 'traps'), true);
  assert.equal(publicView.traps.length, 0);
});

test('identical published map lists reuse the assembled map; synthetic dynamic records are deeply detached', async () => {
  const map = { width: 10, obstacles: [], items: [], gates: [], traps: [], physicsProps: [] };
  const prepared = await prepareMapPayload(map, async () => {});
  const items = [{ id: 'nested', detail: { value: 1 } }], gates = [];
  const read = () => prepared.read({ ...map, items, gates }, { publicMap: true,
    itemsJson: JSON.stringify, gatesJson: JSON.stringify });
  const first = read();
  assert.equal(read(), first);
  assert.throws(() => { first.items[0].detail.value = 2; }, TypeError);
  items[0].detail.value = 3;
  assert.equal(first.items[0].detail.value, 1);
  const changed = read();
  assert.notEqual(changed, first, 'a changed mutable source list invalidates the assembled map');
  assert.equal(changed.items[0].detail.value, 3);
});

test('preparation yields while copying large and nested map arrays', async () => {
  const records = Array.from({ length: 129 }, (_, i) => ({ id: `n${i}`, value: i }));
  const map = {
    seed: 1, width: 1, height: 1, playableArea: { rows: records.map(row => row.id) },
    modules: records, buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [],
    sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], entry: { x: 0, y: 0 },
    exit: { x: 1, y: 1 }, spawns: []
  };
  let opportunities = 0;
  const prepared = await prepareMapPayload(map, async () => { opportunities++; await Promise.resolve(); });
  assert.ok(opportunities > 0);
  const result = prepared.read(map, { itemsJson: JSON.stringify, gatesJson: JSON.stringify });
  assert.equal(result.modules.length, 129);
  assert.equal(result.modules[128].id, 'n128');
  assert.equal(result.playableArea.rows.length, 129);
});

test('prepared replay headers retain the complete ordinary archive bytes', async () => {
  const map = { width: 100, obstacles: [{ x: 10, y: 20, label: 'wall " \\ \u2603' }],
    items: [item('i', 3)], gates: [gate('g', false)], traps: [], physicsProps: [{ id: 'private-prop' }] };
  const prepared = await prepareMapPayload(map, async () => {});
  const payload = prepared.read(map, { itemsJson: JSON.stringify, gatesJson: JSON.stringify });
  const header = { id: 'payload-header', map: payload, optional: undefined, contentId: 'test' };
  const state = { tick: 0 }, commands = [{ type: 'start' }];
  const expected = JSON.stringify({ ...header, frames: [{ state, commands }] });
  const chunks = [];
  const writer = createReplayWriter({ header,
    output: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
    publish: async () => {}, onError: () => {} });
  try {
    assert.equal(writer.append(state, commands), true);
    await writer.finish({ ticks: 0 });
    assert.equal(gunzipSync(Buffer.concat(chunks)).toString('utf8'), expected);
    assert.equal(writer.droppedFrames, 0);
  } finally { writer.abort(); }
});
