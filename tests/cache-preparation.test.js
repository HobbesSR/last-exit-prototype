import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroundItems, itemsNear } from '../shared/simulation/ground-items.ts';
import { botGates, prepareBotGates } from '../shared/simulation/bot-routes.ts';
import { closedGateShapes, prepareSweptGates } from '../shared/simulation/swept.ts';

const counted = (value, onRead, freeze = false) => {
  const record = {};
  Object.defineProperties(record, Object.fromEntries(Object.entries(value).map(([key, field]) =>
    [key, key === 'x' || key === 'y' || key === 'w' || key === 'h' || key === 'id' || key === 'buildingId'
    ? { get() { onRead(key); return field; }, enumerable: true, configurable: true }
    : { value: field, enumerable: true, writable: true, configurable: true }])));
  return freeze ? Object.freeze(record) : record;
};

// Getters are used instead of timing: each indexed record read is observable and deterministic.
function fixture(kind, count = 130) {
  const reads = { x: 0, y: 0, w: 0, h: 0, id: 0, buildingId: 0 };
  const records = Array.from({ length: count }, (_, i) => {
    const hit = key => { reads[key]++; };
    if (kind === 'item') return counted({ id: `i${i}`, kind: 'ammo', x: i * 400, y: 300 }, hit, true);
    return counted({ id: `g${i}`, x: i * 400, y: 300, w: 30, h: 20, open: i % 2 === 0,
      locked: false, kind: 'door', buildingId: `b${i % 3}` }, hit);
  });
  return { records, reads };
}

const noYield = async () => {};

test('ground preparation builds the grid before first query and preserves nearby list order', async () => {
  const { records, reads } = fixture('item');
  await prepareGroundItems(records, noYield);
  assert.ok(reads.x >= records.length, 'preparation has read every item position');
  reads.x = reads.y = 0;
  const nearby = itemsNear(records, { x: 0, y: 300 }, 45);
  assert.deepEqual(nearby.map(item => item.id), ['i0']);
  assert.ok(reads.x < records.length, 'first query does not rebuild the entire grid');
});

test('bot gate preparation publishes ordered lookup tables before lazy access', async () => {
  const { records, reads } = fixture('gate');
  const map = { gates: records };
  await prepareBotGates(map, noYield);
  assert.equal(reads.id, records.length, 'preparation has read every gate id');
  reads.id = reads.buildingId = 0;
  const index = botGates(map);
  assert.equal(reads.id + reads.buildingId, 0, 'first lookup reuses the prepared tables');
  assert.equal(index.byId.size, records.length);
  assert.deepEqual(index.byBuilding.get('b1').map(gate => gate.id), records.filter(gate => gate.buildingId === 'b1').map(gate => gate.id));
});

test('swept gate preparation caches shapes in order and reads open state live', async () => {
  const { records, reads } = fixture('gate');
  await prepareSweptGates(records, noYield);
  assert.ok(reads.x >= records.length && reads.w >= records.length, 'preparation has built every gate shape');
  reads.x = reads.y = reads.w = reads.h = 0;
  const closed = closedGateShapes(records);
  assert.equal(closed.length, 65);
  assert.ok(reads.x + reads.y + reads.w + reads.h < records.length, 'first query reuses prepared shapes');
  assert.equal(closedGateShapes(records).length, 65);
  records[1].open = true;
  assert.equal(closedGateShapes(records).length, 64, 'open state is checked live against cached closed shapes');
});

test('a cancelled ground preparation does not publish its partial grid', async () => {
  const { records, reads } = fixture('item');
  await assert.rejects(prepareGroundItems(records, async () => { throw new Error('cancel'); }), /cancel/);
  reads.x = 0;
  assert.equal(itemsNear(records, { x: 0, y: 300 }, 45)[0], records[0]);
  assert.ok(reads.x >= records.length, 'lazy fallback rebuilt from the full list after cancellation');
});

test('cancelled gate preparations do not publish partial bot or swept indexes', async () => {
  const botFixture = fixture('gate'), map = { gates: botFixture.records };
  await assert.rejects(prepareBotGates(map, async () => { throw new Error('cancel'); }), /cancel/);
  botFixture.reads.id = 0;
  assert.equal(botGates(map).byId.size, botFixture.records.length);
  assert.equal(botFixture.reads.id, botFixture.records.length, 'lazy bot lookup rebuilt after cancellation');

  const sweptFixture = fixture('gate');
  await assert.rejects(prepareSweptGates(sweptFixture.records, async () => { throw new Error('cancel'); }), /cancel/);
  sweptFixture.reads.x = 0;
  assert.equal(closedGateShapes(sweptFixture.records).length, 65);
  assert.ok(sweptFixture.reads.x >= sweptFixture.records.length, 'lazy swept lookup rebuilt after cancellation');
});
