import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, snapshot } from '../shared/simulation.ts';
import { allocateItemId, initializeItemInstances, itemIdForLabel, itemLabel } from '../shared/item-instances.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';
import { arena } from './helpers/arena.js';

test('initial instance IDs stay reserved after their items are consumed', () => {
  const s = createGameRecord(4217, generatedMap(), defaultContent());
  s.content = { ...s.content, itemInstances: { groundCapacity: 2 } };
  s.map.items = [{ id: 'instance-17', lineageId: 'instance-999', kind: 'weapon', weaponType: 'pistol', ammo: 1, x: 0, y: 0 }];
  for (const player of s.players) player.inventory = [null, null, null, null, null, null];
  s.players[0].inventory[0] = { kind: 'cell', charge: 0 };

  const before = s.itemSerial;
  delete s.scatterSerial; // Arrange first initialization of this legacy input.
  initializeItemInstances(s);
  assert.equal(s.scatterSerial, 19, 'only active legacy IDs reserve initial scatter phases');
  const root = s.map.items[0].lineageId, carried = s.players[0].inventory[0].instanceId;
  assert.ok(root >= before && carried > root, 'map items, disappeared roots and carried items share a monotonic domain');
  assert.equal(itemLabel(s, carried), 'instance-18');
  s.map.items.length = 0;
  const next = allocateItemId(s);
  assert.ok(next > carried);
  assert.equal(itemLabel(s, next), 'instance-19');
  assert.equal(itemIdForLabel(s, 'instance-999'), root, 'a lineage-only root stays reserved after its descendant disappears');
});

test('reload identities validate before normalization mutates records and join the numeric domain', () => {
  const fixture = id => {
    const { map } = arena({ cols: 4, rows: 3, spawns: [{ x: 100, y: 100 }] });
    const s = createGameRecord(17, map, { ...defaultContent(),
      roster: { contestants: ['A'], gladiators: [] }, discovery: false });
    s.map.items.push({ id: 'ground', kind: 'cell', charge: 1, x: 300, y: 200 });
    const p = s.players[0];
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1, instanceId: 'held', lineageId: 'root' };
    p.reload = { slot: 0, instanceId: id, until: 20 };
    return { s, p };
  };
  const state = s => structuredClone({ items: s.map.items, players: s.players,
    itemSerial: s.itemSerial, scatterSerial: s.scatterSerial, registry: s.itemIdentities });
  for (const invalid of [undefined, null, '', 0, -1, 1.5, NaN, 999, Number.MAX_SAFE_INTEGER]) {
    const { s } = fixture(invalid), before = state(s);
    assert.throws(() => initializeItemInstances(s), /reload item identity|Unregistered item identity|counter exhausted/);
    assert.deepEqual(state(s), before, 'invalid reload references leave records, counters and the registry untouched');
  }
  for (const label of ['held', 'reload-only']) {
    const { s, p } = fixture(label);
    initializeItemInstances(s);
    assert.equal(typeof p.reload.instanceId, 'number');
    assert.equal(p.reload.instanceId, itemIdForLabel(s, label));
    assert.equal(snapshot(s).players[0].reload.instanceId, p.reload.instanceId);
    assert.ok(allocateItemId(s) > p.reload.instanceId);
  }
});
