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
import { identifyItems, registeredItemId as itemId } from './helpers/item-identity.js';

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
const scatterPhase = s => s.scatterSerial;
const allocationState = s => structuredClone({ itemSerial: s.itemSerial, scatterSerial: s.scatterSerial, registry: s.itemIdentities });

test('scatter follows legacy carried reservations, seed ammo, partial pickup and split/drop phases', () => {
  const { s, p } = fixture();
  s.map.items.push({ id: 'item-999', kind: 'med', count: 1, x: 500, y: 300 });
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 12, instanceId: 'instance-7' };
  p.inventory[1] = { kind: 'med', count: 3 };
  delete s.scatterSerial; // Model a legacy record's first identity initialization.
  identifyItems(s);
  initializeItemInstances(s);
  assert.equal(scatterPhase(s), 9, 'map-placed item IDs do not reserve legacy phases');
  assert.equal(p.inventory[1].instanceId, itemId(s, 'instance-8'));

  // Deliberately separate the namespaces: geometry must keep using phase 9.
  s.itemSerial = 100;
  const weapon = { id: 'item-1000', kind: 'weapon', weaponType: 'pistol', ammo: 12, x: 300, y: 200 };
  s.map.items.push(weapon);
  const seeded = scatterPoint(s, weapon, 9, s.map.items);
  seedAmmo(s, new Map([[weapon, 4]]));
  assert.deepEqual(pose(s.map.items.at(-1)), seeded);
  assert.equal(scatterPhase(s), 10);

  const source = { id: 'item-five', kind: 'shield', count: 5, x: 400, y: 300 };
  s.map.items.push(source);
  identifyItems(s);
  assert.equal(collectInstanceEquipment(s, p, source), false);
  assert.equal(source.count, 2);
  assert.equal(scatterPhase(s), 11, 'partial pickup allocates exactly one child');

  const weaponPoint = scatterPoint(s, p, 11, s.map.items);
  identifyItems(s);
  assert.equal(dropInventorySlot(s, p, 0), true);
  assert.deepEqual(pose(s.map.items.at(-1)), weaponPoint);
  assert.equal(scatterPhase(s), 11, 'identified weapon drop allocates nothing');

  const expected = [];
  for (let i = 0; i < 3; i++) expected.push(scatterPoint(s, p, 11 + i, s.map.items, expected));
  assert.equal(dropInventorySlot(s, p, 1), true);
  assert.deepEqual(s.map.items.slice(-3).map(pose), expected);
  assert.equal(scatterPhase(s), 13, 'identified three-copy stack allocates two children');

  p.reserves.pistol = 2;
  const ammoPoint = scatterPoint(s, p, 13, s.map.items);
  assert.equal(dropReserve(s, p, 'pistol', 2), true);
  assert.deepEqual(pose(s.map.items.at(-1)), ammoPoint);
  assert.equal(scatterPhase(s), 14);
});

test('discarded plans and failed pickup staging do not consume scatter phases', () => {
  const { s, p } = fixture();
  const before = scatterPhase(s);
  const initialAllocation = allocationState(s);
  const planned = planDrop(s, p, { kind: 'med', count: 3 });
  assert.ok(Number.isSafeInteger(planned.itemSerial) && planned.itemSerial > 0, 'planned numeric IDs keep their own counter');
  assert.equal(planned.scatterSerial, 3, 'the legacy schedule remains an independent phase');
  assert.ok(planAmmoDrop(s, p, 'pistol', 2));
  assert.equal(scatterPhase(s), before, 'successful planning alone never commits legacy phases');
  assert.deepEqual(allocationState(s), initialAllocation, 'discarded plans publish neither numeric IDs nor registry additions');
  s.content = { ...s.content, itemInstances: { groundCapacity: 0 } };
  assert.equal(planDrop(s, p, { kind: 'med', count: 3 }), null);
  assert.equal(planAmmoDrop(s, p, 'pistol', 2), null);
  assert.equal(scatterPhase(s), before);

  // The draft pickup identifies five other carried entries, then outgoing stack
  // capacity refuses the swap. Neither staged counter may escape that draft.
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'med', count: 3 };
  p.bot = false;
  s.map.items.push({ id: 'incoming', kind: 'cell', charge: 1, x: p.x, y: p.y });
  identifyItems(s);
  const inventory = structuredClone(p.inventory);
  const stagedAllocation = allocationState(s);
  interact(s, p);
  assert.deepEqual(p.inventory, inventory);
  assert.equal(scatterPhase(s), before);
  assert.deepEqual(allocationState(s), stagedAllocation, 'a rejected swap rolls back both counters and every tentative label');
});

test('occupied legacy allocations preserve their skipped phase and malformed counters fail', () => {
  const { s } = fixture();
  s.map.items.push({ id: 'instance-0', kind: 'cell', charge: 0, x: 500, y: 300 });
  identifyItems(s);
  assert.equal(allocateItemId(s), itemId(s, 'instance-1'));
  assert.equal(scatterPhase(s), 2);
  s.scatterSerial = -1;
  assert.throws(() => allocateItemId(s), /scatter counter/);
  assert.throws(() => initializeItemInstances(s), /configuration/);
});

test('identity initialization preserves an explicit independent scatter phase', () => {
  const { s, p } = fixture();
  s.itemSerial = 100;
  s.scatterSerial = 7;
  p.inventory[0] = { kind: 'med', count: 1 };
  initializeItemInstances(s);
  const next = s.itemSerial;
  assert.ok(Number.isSafeInteger(next) && next > 0);
  assert.equal(scatterPhase(s), 8);
  initializeItemInstances(s);
  assert.deepEqual([s.itemSerial, scatterPhase(s)], [next, 8], 'reinitialization does not reset either counter');
});

test('a committed swap scatters after the pickup stage reservations and commits both counters', () => {
  const { s, p } = fixture();
  s.itemSerial = 100;
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'med', count: 3 };
  p.bot = false;
  const incoming = { id: 'incoming', kind: 'cell', charge: 1, x: p.x, y: p.y };
  s.map.items.push(incoming);
  identifyItems(s);
  const expected = [];
  for (let i = 0; i < 3; i++) expected.push(scatterPoint(s, p, 5 + i, [], expected));
  identifyItems(s);
  const next = s.itemSerial, registered = s.itemIdentities.ids.size;
  interact(s, p);
  assert.equal(p.inventory[0].instanceId, itemId(s, 'incoming'));
  assert.deepEqual(s.map.items.map(pose), expected);
  assert.equal(scatterPhase(s), 8);
  assert.equal(s.itemSerial, next + 8, 'five pickup reservations plus the outgoing identity and two splits');
  assert.equal(s.itemIdentities.ids.size, registered + 8, 'all committed numeric identities have their legacy labels');
});
