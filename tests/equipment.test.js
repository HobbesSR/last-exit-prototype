import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, setInput, step, snapshot, playerView } from '../shared/simulation.js';
import { collectEquipment, WEAPONS, rearrangeEquipment, SLOT_COUNT } from '../shared/equipment.js';

function fixture() {
  const s = createGame(); for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.items = []; s.map.traps = [];
  return { s, p: s.players[0] };
}
test('six slots hold distinct weapons, a cell and capped utility stacks without consuming excess loot', () => {
  const { p } = fixture();
  for (const weaponType of Object.keys(WEAPONS)) assert.ok(collectEquipment(p, { kind: 'weapon', weaponType }));
  assert.equal(collectEquipment(p, { kind: 'weapon', weaponType: 'pistol' }), true);
  assert.equal(p.inventory[0].ammo, WEAPONS.pistol.ammo * 2);
  for (let i = 0; i < 3; i++) assert.ok(collectEquipment(p, { kind: 'med' }));
  for (let i = 0; i < 3; i++) assert.ok(collectEquipment(p, { kind: 'shield' }));
  collectEquipment(p, { kind: 'cell' });
  assert.equal(p.inventory.length, 6); assert.equal(collectEquipment(p, { kind: 'med' }), false);
});

test('weapons stop firing at zero ammo and matching pickups replenish without losing excess rounds', () => {
  const { s, p } = fixture();
  collectEquipment(p, { kind: 'weapon', weaponType: 'pistol', ammo: 1 });
  setInput(s, p.id, { seq: 1, attack: true }); step(s);
  assert.equal(p.inventory[0].ammo, 0); assert.equal(s.projectiles.length, 1);
  s.projectiles = []; p.attackCd = 0;
  setInput(s, p.id, { seq: 2, attack: true }); step(s);
  assert.equal(s.projectiles.length, 0);
  p.inventory[0].ammo = WEAPONS.pistol.maxAmmo - 2;
  const loot = { kind: 'weapon', weaponType: 'pistol', ammo: 10 };
  assert.equal(collectEquipment(p, loot), false);
  assert.equal(loot.ammo, 8); assert.equal(p.inventory[0].ammo, WEAPONS.pistol.maxAmmo);
  assert.equal(collectEquipment(p, loot), false); assert.equal(loot.ammo, 8);
});

test('slot moves follow selection, merge compatible stacks, swap cells and reject invalid requests', () => {
  const { s, p } = fixture();
  p.inventory[0] = { kind: 'med', count: 2 }; p.inventory[1] = { kind: 'med', count: 2 };
  assert.ok(rearrangeEquipment(p, 0, 1)); assert.equal(p.inventory[0].count, 1); assert.equal(p.inventory[1].count, 3);
  assert.equal(rearrangeEquipment(p, 0, 1), false);
  p.inventory[2] = { kind: 'cell', charge: 71 };
  setInput(s, p.id, { seq: 1, slot: 2, moveSlot: { from: 2, to: 5 } });
  setInput(s, p.id, { seq: 2 }); step(s);
  assert.equal(p.selectedSlot, 5); assert.equal(p.inventory[5].charge, 71); assert.equal(p.inventory[2], null);
  assert.equal(p.input.moveSlot, undefined);
  assert.equal(rearrangeEquipment(p, -1, 0), false); assert.equal(rearrangeEquipment(p, 5, SLOT_COUNT), false);
  assert.equal(rearrangeEquipment(p, 1.2, 0), false);
  const before = structuredClone(p.inventory);
  setInput(s, p.id, { seq: 3, moveSlot: { from: 5, to: 999 } }); step(s);
  assert.deepEqual(p.inventory, before);
});

test('dropped weapons keep remaining ammo and a sixth-slot item can be selected', () => {
  const { s, p } = fixture();
  p.inventory[5] = { kind: 'weapon', weaponType: 'rifle', ammo: 7 };
  setInput(s, p.id, { seq: 1, slot: 5, drop: true }); step(s);
  assert.equal(p.selectedSlot, 5); assert.equal(p.inventory[5], null);
  assert.equal(s.map.items.find(i => i.weaponType === 'rifle').ammo, 7);
});
test('slot selection is validated and latched; firing uses the selected weapon and utilities consume charges', () => {
  const { s, p } = fixture();
  for (const weaponType of Object.keys(WEAPONS)) collectEquipment(p, { kind: 'weapon', weaponType });
  collectEquipment(p, { kind: 'med' });
  setInput(s, p.id, { seq: 1, slot: 2 }); setInput(s, p.id, { seq: 2, attack: true, aim: 0 }); step(s);
  assert.equal(p.selectedSlot, 2); assert.equal(s.projectiles.length, 5); assert.equal(p.attackCd, WEAPONS.scattergun.cooldown);
  setInput(s, p.id, { seq: 3, slot: 999 }); step(s); assert.equal(p.selectedSlot, 2);
  p.attackCd = 0; p.hp = 50;
  setInput(s, p.id, { seq: 4, slot: 3, attack: true }); step(s);
  assert.equal(p.hp, 90); assert.equal(p.inventory[3], null); assert.equal(p.weapon, 0);
  const view = playerView(s, snapshot(s), s.players[1].id);
  assert.equal(Object.hasOwn(view.players.find(other => other.id === p.id), 'inventory'), false);
});
