import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../shared/simulation.ts';
import { allocateItemId, initializeItemInstances } from '../shared/item-instances.ts';

test('initial instance IDs stay reserved after their items are consumed', () => {
  const s = createGame();
  s.content = { ...s.content, itemInstances: { groundCapacity: 2 } };
  s.map.items = [{ id: 'instance-17', kind: 'weapon', weaponType: 'pistol', ammo: 1, x: 0, y: 0 }];
  for (const player of s.players) player.inventory = [null, null, null, null, null, null];
  s.players[0].inventory[0] = { kind: 'cell', charge: 0 };

  initializeItemInstances(s);
  assert.equal(s.itemSerial, 19);
  assert.equal(s.players[0].inventory[0].instanceId, 'instance-18');
  s.map.items.length = 0;
  assert.equal(allocateItemId(s), 'instance-19');
});
