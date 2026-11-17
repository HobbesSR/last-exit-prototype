import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord } from '../shared/simulation.ts';
import { allocateItemId, initializeItemInstances, itemIdForLabel, itemLabel } from '../shared/item-instances.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';

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
