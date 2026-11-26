import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord } from '../shared/simulation/state.ts';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { allocateItemId, initializeItemInstances } from '../shared/item-instances.ts';
import { seedAmmo } from '../shared/simulation/ammo.ts';
import { scatterPoint } from '../shared/simulation/loot.ts';
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

// The live drops, pickups and swaps are the core's, which places by its own seeded score rather than these phases
// (`rust/core/src/tick/tests/item_tests.rs`); what remains is the setup path: identity initialization and `seedAmmo`.
test('scatter follows legacy carried reservations and seed ammo', () => {
  const { s, p } = fixture();
  s.items.push({ id: 'item-999', kind: 'med', count: 1, x: 500, y: 300 });
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
  s.items.push(weapon);
  const seeded = scatterPoint(s, weapon, 9, s.items);
  seedAmmo(s, new Map([[weapon, 4]]));
  assert.deepEqual(pose(s.items.at(-1)), seeded);
  assert.equal(scatterPhase(s), 10);
});

test('occupied legacy allocations preserve their skipped phase and malformed counters fail', () => {
  const { s } = fixture();
  s.items.push({ id: 'instance-0', kind: 'cell', charge: 0, x: 500, y: 300 });
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
