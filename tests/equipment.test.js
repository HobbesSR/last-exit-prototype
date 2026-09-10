import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, setInput, step, snapshot, playerView } from '../shared/simulation.js';
import { collectEquipment, WEAPONS } from '../shared/equipment.js';

function fixture() {
  const s = createGame(); for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.items = []; s.map.traps = [];
  return { s, p: s.players[0] };
}
test('five slots hold distinct weapons and capped utility stacks without consuming excess loot', () => {
  const { p } = fixture();
  for (const weaponType of Object.keys(WEAPONS)) assert.ok(collectEquipment(p, { kind: 'weapon', weaponType }));
  assert.equal(collectEquipment(p, { kind: 'weapon', weaponType: 'pistol' }), false);
  for (let i = 0; i < 3; i++) assert.ok(collectEquipment(p, { kind: 'med' }));
  for (let i = 0; i < 3; i++) assert.ok(collectEquipment(p, { kind: 'shield' }));
  assert.equal(p.inventory.length, 5); assert.equal(collectEquipment(p, { kind: 'med' }), false);
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
