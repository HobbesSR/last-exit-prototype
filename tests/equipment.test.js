import { renderedPlayerView as playerView } from './helpers/relational.js';
import { identifyItems } from './helpers/item-identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { phaseThree } from '../shared/simulation/phase-three.ts';
import { disposePhysics, setInput, stateOf, step, snapshot, } from '../shared/simulation.ts';
import { WEAPONS, SLOT_COUNT } from '../shared/equipment.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { openField } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';

// Equipment on the shipped content and its engine (#920): a contestant on open ground, another in sight to the north
// and a gladiator far off, all played by the test.
const scene = body => async () => {
  const { map } = openField(3000);
  const { s, players: [p] } = await stagePhysics(map, { content: defaultContent(), actors: [{ role: 'contestant', bot: false, x: 600, y: 576 },
    { role: 'contestant', bot: false, x: 600, y: 200 }, { role: 'gladiator', bot: false, x: 2400, y: 1000 }] });
  for (const q of s.players) q.input = {};
  try { await body({ s, p }); } finally { disposePhysics(s); }
};
// Exercise only this actor's phase-three action, without unrelated ground pickups.
const moveSlot = (s, p, from, to) => {
  identifyItems(s);
  const state = () => ({ inventory: p.inventory, selectedSlot: p.selectedSlot, weapon: p.weapon,
    itemSerial: s.itemSerial, scatterSerial: s.scatterSerial });
  const before = structuredClone(state());
  phaseThree(s, s.players.map(actor => actor === p ? { input: { moveSlot: { from, to } } } : undefined));
  return !isDeepStrictEqual(state(), before);
};
// The pickup rules (a duplicate weapon topping up, utility stacks capping, a full inventory) are the core's: see
// `rust/core/src/tick/tests/item_tests.rs`, `a_duplicate_firearm_tops_up_to_capacity_and_the_rest_stays_on_the_ground`
// and `partial_stacks_fill_remaining_capacity_in_claim_order`. What follows arranges inventory on the game before the start.
const carried = (s, p, slot, fields) => {
  p.inventory[slot] = { instanceId: `held-${slot}`, lineageId: `held-${slot}`, ...fields };
  identifyItems(s);
};

test('weapons stop firing at zero ammo', scene(({ s, p }) => {
  carried(s, p, 0, { kind: 'weapon', weaponType: 'pistol', ammo: 1 });
  setInput(s, p.id, { seq: 1, attack: true }); step(s);
  assert.equal(now(s, p).inventory[0].ammo, 0); assert.equal(stateOf(s).projectiles.length, 1);
  for (let i = 0; i < WEAPONS.pistol.life; i++) step(s);
  setInput(s, p.id, { seq: 2, attack: true }); step(s);
  assert.equal(stateOf(s).projectiles.length, 0);
}));

// The merge and rejection rules, on the arranged record (a unit test of phase three: it does not step).
test('slot moves merge compatible stacks and reject invalid requests', scene(({ s, p }) => {
  p.inventory[0] = { kind: 'med', count: 2 }; p.inventory[1] = { kind: 'med', count: 2 };
  assert.ok(moveSlot(s, p, 0, 1)); assert.equal(p.inventory[0].count, 1); assert.equal(p.inventory[1].count, 3);
  assert.equal(moveSlot(s, p, 0, 1), false);
}));

test('slot moves follow selection and swap cells', scene(({ s, p }) => {
  p.inventory[2] = { kind: 'cell', charge: 71, instanceId: 'cell-71', lineageId: 'cell-71' };
  identifyItems(s);
  setInput(s, p.id, { seq: 1, slot: 2 }); step(s);
  setInput(s, p.id, { seq: 2, moveSlot: { from: 2, to: 5 } }); step(s);
  let me = now(s, p);
  assert.equal(me.selectedSlot, 5); assert.equal(me.inventory[5].charge, 71); assert.equal(me.inventory[2], null);
  const settled = structuredClone(me.inventory);
  step(s);
  assert.deepEqual(now(s, p).inventory, settled, 'an input a tick already spent is not applied again');
  const before = structuredClone(now(s, p).inventory);
  setInput(s, p.id, { seq: 3, moveSlot: { from: 5, to: 999 } }); step(s);
  assert.deepEqual(now(s, p).inventory, before);
}));

test('dropped weapons keep remaining ammo and a sixth-slot item can be selected', scene(({ s, p }) => {
  p.inventory[5] = { kind: 'weapon', weaponType: 'rifle', ammo: 7, instanceId: 'held-rifle', lineageId: 'held-rifle' };
  identifyItems(s);
  setInput(s, p.id, { seq: 1, slot: 5 }); step(s);
  setInput(s, p.id, { seq: 2, drop: true }); step(s);
  assert.equal(now(s, p).selectedSlot, 5); assert.equal(now(s, p).inventory[5], null);
  assert.equal(stateOf(s).items.find(i => i.weaponType === 'rifle').ammo, 7);
}));

test('slot selection is validated and held; firing uses the selected weapon and utilities consume charges', scene(({ s, p }) => {
  Object.keys(WEAPONS).forEach((weaponType, slot) => carried(s, p, slot, { kind: 'weapon', weaponType, ammo: WEAPONS[weaponType].ammo }));
  carried(s, p, Object.keys(WEAPONS).length, { kind: 'med', count: 1 });
  p.hp = 50;
  setInput(s, p.id, { seq: 1, slot: 2 }); step(s);
  assert.equal(now(s, p).selectedSlot, 2);
  setInput(s, p.id, { seq: 2, attack: true, aim: 0 }); step(s);
  assert.equal(stateOf(s).projectiles.length, 5); assert.equal(now(s, p).attackCd, WEAPONS.scattergun.cooldown);
  setInput(s, p.id, { seq: 3, slot: 999 }); step(s); assert.equal(now(s, p).selectedSlot, 2);
  while (now(s, p).attackCd > 0) step(s);
  setInput(s, p.id, { seq: 4, slot: 3 }); step(s);
  setInput(s, p.id, { seq: 5, attack: true }); step(s);
  assert.equal(now(s, p).hp, 90); assert.equal(now(s, p).inventory[3], null); assert.equal(now(s, p).weapon, 0);
  const view = playerView(s, snapshot(s), s.players[1].id);
  assert.equal(Object.hasOwn(view.players.find(other => other.id === p.id), 'inventory'), false);
}));
