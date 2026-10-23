import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../shared/simulation.ts';
import { botInput, collectBotIntent } from '../shared/simulation/bots.ts';

function fixture() {
  const s = createGame(438);
  for (const p of s.players) p.bot = false;
  const p = s.players[0];
  p.bot = true;
  p.discovery = undefined; // The legacy whole-map bot sees the test's placed cell.
  s.map.items = [];
  s.map.traps = [];
  return { s, p };
}

function publicState(s, p) {
  return structuredClone({ inventory: p.inventory, hp: p.hp, shield: p.shield, selectedSlot: p.selectedSlot,
    weapon: p.weapon, attackCd: p.attackCd, cooldown: p.cooldown, serial: s.serial,
    items: s.map.items, effects: s.effects, projectiles: s.projectiles });
}

test('collecting a healing intent leaves public state untouched; legacy bot still heals immediately', () => {
  const { s, p } = fixture();
  p.hp = 40;
  p.selectedSlot = 4;
  p.inventory = [{ kind: 'med', count: 1 }, { kind: 'weapon', weaponType: 'pistol', ammo: 5 }, null, null, null, null];
  const before = publicState(s, p);
  const intent = collectBotIntent(s, p);
  assert.equal(intent.input.slot, 0);
  assert.equal(intent.utilitySlot, 0);
  assert.equal(intent.discardSlot, undefined);
  assert.deepEqual(publicState(s, p), before);

  botInput(s, p);
  assert.equal(p.hp, 80);
  assert.equal(p.inventory[0], null);
  assert.equal(p.selectedSlot, 0);
  assert.ok(p.attackCd > 0);
});

test('collecting a cell pursuit intent reports the discard slot without dropping', () => {
  const { s, p } = fixture();
  p.inventory = [
    { kind: 'weapon', weaponType: 'pistol', ammo: 4 },
    { kind: 'shield', count: 2 },
    { kind: 'weapon', weaponType: 'rifle', ammo: 1 },
    { kind: 'weapon', weaponType: 'scattergun', ammo: 1 },
    { kind: 'weapon', weaponType: 'pistol', ammo: 0 },
    { kind: 'med', count: 2 },
  ];
  p.shield = 75;
  p.hp = 100;
  s.map.items.push({ id: 'wanted-cell', kind: 'cell', x: p.x + 200, y: p.y, charge: 0 });
  const before = publicState(s, p);
  const intent = collectBotIntent(s, p);
  assert.equal(intent.discardSlot, 1);
  assert.deepEqual(publicState(s, p), before);

  botInput(s, p);
  assert.equal(p.inventory[1], null);
  assert.ok(s.map.items.some(item => item.droppedBy === p.id && item.kind === 'shield'));
});
