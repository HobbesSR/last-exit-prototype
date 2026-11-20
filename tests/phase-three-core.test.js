import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, setInput, snapshot, step } from '../shared/simulation.ts';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { planDrop } from '../shared/simulation/loot.ts';
import { arena } from './helpers/arena.js';
import { itemId, itemLabel } from './helpers/item-identity.js';

// Phase 3's bounded witnesses (27, step 5c.2): one or two ticks on an empty arena. The frozen
// match trace rarely rearranges unidentified items or combines a slot drop and reserve drop.
async function fixture(t, { ammo = false, capacity } = {}) {
  const content = structuredClone(ammo ? contentById('content-ammo-1') : defaultContent());
  content.roster = { contestants: ['A', 'B'], gladiators: [] };
  content.discovery = false;
  if (capacity !== undefined) content.itemInstances.groundCapacity = capacity;
  const { map } = arena({ cols: 12, rows: 6, cellSize: 100,
    spawns: [{ x: 300, y: 300 }, { x: 900, y: 300 }] });
  const s = await createGame(1238, map, content);
  t.after(() => disposePhysics(s));
  for (const p of s.players) {
    p.bot = false;
    p.inventory.fill(null);
    p.selectedSlot = 0;
    p.weapon = 0;
    p.reload = null;
  }
  return { s, p: s.players[0], q: s.players[1] };
}

function input(s, p, fields) {
  assert.ok(setInput(s, p.id, { seq: s.tick + 1, ...fields }));
}

const counters = s => [s.itemSerial, s.scatterSerial];
const dropped = s => s.items.filter(item => item.droppedBy !== undefined);
const bodyGeneration = (s, label) => snapshot(s).physics.world.bodies.find(body => body.spec.id === `item:${label}`)?.generation;

test('phase 3 commits droppers by actor ID even when their roster is reversed', async t => {
  const { s, p, q } = await fixture(t);
  p.inventory[0] = { kind: 'med', count: 1 };
  q.inventory[0] = { kind: 'shield', count: 1 };
  const [nextId, phase] = counters(s);
  s.players.reverse();
  input(s, q, { drop: true });
  input(s, p, { drop: true });
  step(s);
  assert.deepEqual(dropped(s).map(item => [item.droppedBy, item.kind, item.id]), [
    [p.id, 'med', nextId], [q.id, 'shield', nextId + 1],
  ]);
  assert.deepEqual(dropped(s).map(item => itemLabel(s, item.id)), [`instance-${phase}`, `instance-${phase + 1}`]);
  assert.deepEqual(counters(s), [nextId + 2, phase + 2]);
  assert.equal(p.inventory[0], null);
  assert.equal(q.inventory[0], null);
});

test('one player admits the slot drop before the ammo drop in the same input', async t => {
  const { s, p } = await fixture(t, { ammo: true });
  const id = itemId(s, 'z-carried');
  p.inventory[0] = { kind: 'med', count: 1, instanceId: id, lineageId: id };
  p.reserves.pistol = 7;
  const [nextId, phase] = counters(s);
  input(s, p, { drop: true, dropAmmo: { family: 'pistol', count: 4 } });
  step(s);
  assert.deepEqual(dropped(s).map(item => [item.kind, item.id, item.count]), [['med', id, 1], ['ammo', nextId, 4]]);
  assert.deepEqual(counters(s), [nextId + 1, phase + 1]);
  assert.equal(p.reserves.pistol, 3);
  assert.equal(p.inventory[0], null);
  // A deferred batch sync would admit instance-N before z-carried by label order. Generations
  // expose the allocation order even though the public body list itself is sorted by label.
  const slot = bodyGeneration(s, 'z-carried'), ammo = bodyGeneration(s, `instance-${phase}`);
  assert.ok(Number.isSafeInteger(slot) && Number.isSafeInteger(ammo));
  assert.ok(slot < ammo, `slot generation ${slot}, ammo generation ${ammo}`);
});

test('splitting a three-count drop skips a reserved label without consuming its numeric ID', async t => {
  const { s, p } = await fixture(t);
  const phase = s.scatterSerial;
  itemId(s, `instance-${phase + 1}`); // Metadata reserves a phase without advancing scatter.
  const [nextId] = counters(s);
  p.inventory[0] = { kind: 'med', count: 3, quality: 2 };
  input(s, p, { drop: true });
  step(s);
  assert.deepEqual(dropped(s).map(item => [item.id, item.lineageId, item.count, item.quality]), [
    [nextId, nextId, 1, 2], [nextId + 1, nextId, 1, 2], [nextId + 2, nextId, 1, 2],
  ]);
  assert.deepEqual(dropped(s).map(item => itemLabel(s, item.id)), [phase, phase + 2, phase + 3].map(n => `instance-${n}`));
  assert.ok(dropped(s).every(item => !Object.hasOwn(item, 'instanceId')));
  assert.deepEqual(counters(s), [nextId + 3, phase + 4]);
  assert.equal(p.inventory[0], null);
});

test('capacity refusal keeps an unidentified stack, reserves and both allocation counters', async t => {
  const { s, p } = await fixture(t, { ammo: true, capacity: 0 });
  const carried = { kind: 'med', count: 3 };
  p.inventory[0] = carried;
  p.reserves.pistol = 5;
  const before = counters(s);
  input(s, p, { drop: true, dropAmmo: { family: 'pistol', count: 2 } });
  step(s);
  assert.equal(p.inventory[0], carried);
  assert.deepEqual(carried, { kind: 'med', count: 3 });
  assert.equal(p.reserves.pistol, 5);
  assert.deepEqual(counters(s), before);
  assert.deepEqual(s.items, []);
});

test('a successful rearrangement identifies all carried objects in their original slot order', async t => {
  const { s, p } = await fixture(t);
  const med = { kind: 'med', count: 2 }, shield = { kind: 'shield', count: 1 };
  const gun = { kind: 'weapon', weaponType: 'pistol', ammo: 1 };
  p.inventory[0] = med; p.inventory[1] = shield; p.inventory[4] = gun;
  const [nextId, phase] = counters(s);
  input(s, p, { moveSlot: { from: 4, to: 4 } });
  step(s);
  assert.deepEqual(counters(s), [nextId, phase], 'a rejected rearrangement allocates nothing');
  input(s, p, { moveSlot: { from: 4, to: 2 } });
  step(s);
  assert.equal(p.inventory[0], med);
  assert.equal(p.inventory[1], shield);
  assert.equal(p.inventory[2], gun);
  assert.equal(p.inventory[4], null);
  assert.deepEqual([med, shield, gun].map(item => [item.instanceId, item.lineageId]), [0, 1, 2].map(i => [nextId + i, nextId + i]));
  assert.deepEqual([med, shield, gun].map(item => itemLabel(s, item.instanceId)), [0, 1, 2].map(i => `instance-${phase + i}`));
  assert.deepEqual(counters(s), [nextId + 3, phase + 3]);
});

test('selection cancels a due reload before transfer and allows the newly selected weapon to fire', async t => {
  const { s, p } = await fixture(t, { ammo: true });
  const emptyId = itemId(s, 'empty'), loadedId = itemId(s, 'loaded');
  const empty = { kind: 'weapon', weaponType: 'pistol', ammo: 0, instanceId: emptyId, lineageId: emptyId };
  const loaded = { kind: 'weapon', weaponType: 'pistol', ammo: 1, instanceId: loadedId, lineageId: loadedId };
  p.inventory[0] = empty; p.inventory[1] = loaded;
  p.reserves.pistol = 12;
  p.reload = { slot: 0, instanceId: emptyId, until: s.tick + 1 };
  const before = counters(s);
  input(s, p, { slot: 1, attack: true, aim: 0 });
  step(s);
  assert.equal(p.selectedSlot, 1);
  assert.equal(p.reload, null);
  assert.equal(p.reserves.pistol, 12);
  assert.equal(empty.ammo, 0, 'the interrupted reload transfers no rounds on its due tick');
  assert.equal(loaded.ammo, 0);
  assert.deepEqual(s.projectiles.map(projectile => projectile.owner), [p.id]);
  assert.deepEqual(counters(s), before);
});

test('drop planning refuses explicit NaN payload metadata without treating it as absent', async t => {
  const { s, p } = await fixture(t);
  const before = counters(s);
  const invalid = [
    { kind: 'med', count: 1, quality: NaN },
    { kind: 'med', count: 1, instanceId: NaN },
    { kind: 'med', count: 1, lineageId: NaN },
    { kind: 'weapon', weaponType: 'pistol', ammo: NaN },
    { kind: 'cell', charge: NaN },
  ];
  for (const item of invalid) {
    const original = { ...item };
    assert.equal(planDrop(s, p, item), null, `invalid fields: ${Object.keys(item).join(', ')}`);
    assert.deepEqual(item, original);
    assert.deepEqual(counters(s), before);
  }
  assert.deepEqual(s.items, []);
});

test('an exhausted rearrangement throws before moving the item or firing the selected weapon', async t => {
  const { s, p } = await fixture(t);
  const id = itemId(s, 'still-loaded');
  const carried = { kind: 'med', count: 2 };
  const gun = { kind: 'weapon', weaponType: 'pistol', ammo: 1, instanceId: id, lineageId: id };
  p.inventory[0] = carried; p.inventory[1] = gun; p.selectedSlot = 1;
  s.itemSerial = Number.MAX_SAFE_INTEGER;
  const before = counters(s), origin = { x: p.x, y: p.y };
  input(s, p, { moveSlot: { from: 0, to: 2 }, attack: true, x: 1 });
  assert.throws(() => step(s), /Item instance counter exhausted/);
  assert.equal(p.inventory[0], carried);
  assert.equal(p.inventory[2], null);
  assert.deepEqual(carried, { kind: 'med', count: 2 });
  assert.equal(gun.ammo, 1);
  assert.deepEqual(s.projectiles, []);
  assert.deepEqual({ x: p.x, y: p.y }, origin);
  assert.deepEqual(counters(s), before);
});

test('merging and consuming a final stack updates the original object after its slot is cleared', async t => {
  const { s, p } = await fixture(t);
  const source = { kind: 'med', count: 1 }, target = { kind: 'med', count: 2 };
  p.inventory[0] = source; p.inventory[1] = target;
  input(s, p, { moveSlot: { from: 0, to: 1 } }); step(s);
  assert.equal(p.inventory[0], null);
  assert.equal(p.inventory[1], target);
  assert.equal(source.count, 0);
  assert.equal(target.count, 3);
  const consumed = { kind: 'med', count: 1 };
  p.inventory[0] = consumed; p.selectedSlot = 0; p.hp = 40;
  input(s, p, { attack: true }); step(s);
  assert.equal(p.inventory[0], null);
  assert.equal(consumed.count, 0);
  assert.equal(p.hp, 80);
});

test('reload completion preserves an explicit NaN write when the carried magazine was absent', async t => {
  const { s, p } = await fixture(t, { ammo: true });
  const id = itemId(s, 'missing-magazine');
  const gun = { kind: 'weapon', weaponType: 'pistol', instanceId: id, lineageId: id };
  p.inventory[0] = gun; p.reserves.pistol = 3;
  p.reload = { slot: 0, instanceId: id, until: s.tick + 1 };
  step(s);
  assert.ok(Object.hasOwn(gun, 'ammo'));
  assert.ok(Number.isNaN(gun.ammo));
  assert.ok(Number.isNaN(p.reserves.pistol));
  assert.equal(p.reload, null);
});
