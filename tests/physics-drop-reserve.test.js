import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, snapshot, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { dropInventorySlot } from '../shared/simulation/loot.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';

// A real 12x6 map has hundreds of ground items and the world has 128 dynamic bodies for actors, props and loot.
// Without a reserve the items take every slot at tick 0 and a player's voluntary drop has nowhere to go (#523).
const map = generateLiveMap(4217, contentById('content-6'), DEFAULT_LIVE_ZONE_SIZE);

async function room(contentId) {
  const s = await createPhysicsGame(4217, structuredClone(map), contentById(contentId));
  const p = s.players.find(q => q.role === 'contestant');
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48, instanceId: 'held-1', lineageId: 'held-1' };
  p.selectedSlot = 0;
  return { s, r: physicsRuntime(s), p };
}

test('the lab content fills the world with map items, so no drop can be admitted', async () => {
  const { s, r, p } = await room('content-physics-8');
  try {
    assert.ok(s.map.items.length > 128, 'a real map has more items than the world has slots');
    assert.equal(r.world.canAddBodies(1), false, 'the world is full at tick 0');
    const held = p.inventory[0];
    dropInventorySlot(s, p, 0);
    assert.deepEqual(p.inventory[0], held, 'an optional drop with no slot preserves the inventory');
  } finally { disposePhysics(s); }
});

test('the shipped content leaves a reserve, so a player can drop and the item gets a body', async () => {
  const { s, r, p } = await room('content-6');
  try {
    const reserve = s.content.worldPhysics.dropReserve, free = () => 128 - r.world.counts().dynamic;
    assert.ok(reserve > 0 && free() >= reserve, `ordinary items leave the reserve free: ${free()} of ${reserve}`);
    const held = p.inventory[0];
    dropInventorySlot(s, p, 0);
    assert.equal(p.inventory[0], null, 'the drop empties the slot');
    assert.ok(s.map.items.some(item => item.id === held.instanceId), 'and the item is on the ground');
    step(s);
    assert.equal(r.items.has(`item:${held.instanceId}`), true, 'with a body, admitted from the reserve');
    assert.ok(free() >= reserve - 1, 'one slot used, the rest still free');
    assert.doesNotThrow(() => snapshot(s));
  } finally { disposePhysics(s); }
});

test('a reserve that is not a small nonnegative integer is refused before a solver is built', async () => {
  for (const dropReserve of [-1, 1.5, 97, Number.NaN]) {
    const content = structuredClone(contentById('content-6'));
    content.worldPhysics.dropReserve = dropReserve;
    await assert.rejects(() => createPhysicsGame(4217, structuredClone(map), content), /invalid world physics profile/, String(dropReserve));
  }
});
