import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord } from '../shared/simulation/state.ts';
import { contentById } from '../shared/simulation/content.ts';
import { allocateItemId, initializeItemInstances } from '../shared/item-instances.ts';
import { collectInstanceEquipment } from '../shared/equipment.ts';
import { seedAmmo, dropReserve } from '../shared/simulation/ammo.ts';
import { dropInventorySlot, planDrop, planAmmoDrop, scatterPoint } from '../shared/simulation/loot.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { arena } from './helpers/arena.js';

// A cheap schedule witness, without Rapier or generated maps. Explicit phases below
// are the old allocator's reservation/allocation counts (24.4), not the new counter.
function fixture() {
  const { map } = arena({ cols: 6, rows: 4, cellSize: 100, spawns: [{ x: 120, y: 200 }] });
  const content = { ...structuredClone(contentById('content-ammo-1')),
    roster: { contestants: ['A'], gladiators: [] }, discovery: false };
  const s = createGameRecord(17, map, content);
  return { s, p: s.players[0] };
}
const pose = ({ x, y }) => ({ x, y });
const counters = s => [s.itemSerial, s.scatterSerial];

test('scatter follows legacy carried reservations, seed ammo, partial pickup and split/drop phases', () => {
  const { s, p } = fixture();
  s.map.items.push({ id: 'item-999', kind: 'med', count: 1, x: 500, y: 300 });
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 12, instanceId: 'instance-7' };
  p.inventory[1] = { kind: 'med', count: 3 };
  initializeItemInstances(s);
  assert.deepEqual(counters(s), [9, 9], 'map-placed item IDs do not reserve legacy phases');
  assert.equal(p.inventory[1].instanceId, 'instance-8');

  // Deliberately separate the namespaces: geometry must keep using phase 9.
  s.itemSerial = 100;
  const weapon = { id: 'item-1000', kind: 'weapon', weaponType: 'pistol', ammo: 12, x: 300, y: 200 };
  s.map.items.push(weapon);
  const seeded = scatterPoint(s, weapon, 9, s.map.items);
  seedAmmo(s, new Map([[weapon, 4]]));
  assert.deepEqual(pose(s.map.items.at(-1)), seeded);
  assert.deepEqual(counters(s), [101, 10]);

  const source = { id: 'item-five', kind: 'shield', count: 5, x: 400, y: 300 };
  s.map.items.push(source);
  assert.equal(collectInstanceEquipment(s, p, source), false);
  assert.equal(source.count, 2);
  assert.deepEqual(counters(s), [102, 11], 'partial pickup allocates exactly one child');

  const weaponPoint = scatterPoint(s, p, 11, s.map.items);
  assert.equal(dropInventorySlot(s, p, 0), true);
  assert.deepEqual(pose(s.map.items.at(-1)), weaponPoint);
  assert.deepEqual(counters(s), [102, 11], 'identified weapon drop allocates nothing');

  const expected = [];
  for (let i = 0; i < 3; i++) expected.push(scatterPoint(s, p, 11 + i, s.map.items, expected));
  assert.equal(dropInventorySlot(s, p, 1), true);
  assert.deepEqual(s.map.items.slice(-3).map(pose), expected);
  assert.deepEqual(counters(s), [104, 13], 'identified three-copy stack allocates two children');

  p.reserves.pistol = 2;
  const ammoPoint = scatterPoint(s, p, 13, s.map.items);
  assert.equal(dropReserve(s, p, 'pistol', 2), true);
  assert.deepEqual(pose(s.map.items.at(-1)), ammoPoint);
  assert.deepEqual(counters(s), [105, 14]);
});

test('discarded plans and failed pickup staging do not consume scatter phases', () => {
  const { s, p } = fixture();
  const before = counters(s);
  const planned = planDrop(s, p, { kind: 'med', count: 3 });
  assert.deepEqual([planned.itemSerial, planned.scatterSerial], [3, 3]);
  assert.ok(planAmmoDrop(s, p, 'pistol', 2));
  assert.deepEqual(counters(s), before, 'successful planning alone never commits counters');
  s.content = { ...s.content, itemInstances: { groundCapacity: 0 } };
  assert.equal(planDrop(s, p, { kind: 'med', count: 3 }), null);
  assert.equal(planAmmoDrop(s, p, 'pistol', 2), null);
  assert.deepEqual(counters(s), before);

  // The draft pickup identifies five other carried entries, then outgoing stack
  // capacity refuses the swap. Neither staged counter may escape that draft.
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'med', count: 3 };
  p.bot = false;
  s.map.items.push({ id: 'incoming', kind: 'cell', charge: 1, x: p.x, y: p.y });
  const inventory = structuredClone(p.inventory);
  interact(s, p);
  assert.deepEqual(p.inventory, inventory);
  assert.deepEqual(counters(s), before);
});

test('occupied legacy allocations preserve their skipped phase and malformed counters fail', () => {
  const { s } = fixture();
  s.map.items.push({ id: 'instance-0', kind: 'cell', charge: 0, x: 500, y: 300 });
  assert.equal(allocateItemId(s), 'instance-1');
  assert.deepEqual(counters(s), [2, 2]);
  s.scatterSerial = -1;
  assert.throws(() => allocateItemId(s), /scatter counter/);
  assert.throws(() => initializeItemInstances(s), /configuration/);
});

test('a committed swap scatters after the pickup stage reservations and commits both counters', () => {
  const { s, p } = fixture();
  s.itemSerial = 100;
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'med', count: 3 };
  p.bot = false;
  const incoming = { id: 'incoming', kind: 'cell', charge: 1, x: p.x, y: p.y };
  s.map.items.push(incoming);
  const expected = [];
  for (let i = 0; i < 3; i++) expected.push(scatterPoint(s, p, 5 + i, [], expected));
  interact(s, p);
  assert.equal(p.inventory[0].instanceId, 'incoming');
  assert.deepEqual(s.map.items.map(pose), expected);
  assert.deepEqual(counters(s), [108, 8]);
});
