import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../shared/simulation.ts';
import { collectBotIntent } from '../shared/simulation/bots.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';
import { know } from './helpers/scenario.js';

// A bot collects an intent and the tick applies it. Neither case steps the match, so the game is built on the
// shipped content and the room arena without its physics world.
function fixture() {
  const s = createGame(438, generatedMap(), defaultContent());
  for (const p of s.players) p.bot = false;
  const p = s.players[0];
  p.bot = true;
  know(s, p);
  s.map.items = [];
  s.map.traps = [];
  return { s, p };
}

function publicState(s, p) {
  return structuredClone({ inventory: p.inventory, hp: p.hp, shield: p.shield, selectedSlot: p.selectedSlot,
    weapon: p.weapon, attackCd: p.attackCd, cooldown: p.cooldown, serial: s.serial,
    items: s.map.items, effects: s.effects, projectiles: s.projectiles });
}

function healing() {
  const { s, p } = fixture();
  p.hp = 40;
  p.selectedSlot = 4;
  p.inventory = [{ kind: 'med', count: 1 }, { kind: 'weapon', weaponType: 'pistol', ammo: 5 }, null, null, null, null];
  return { s, p };
}

function pursuing() {
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
  const cell = { id: 'wanted-cell', kind: 'cell', x: p.x + 200, y: p.y, charge: 0 };
  s.map.items.push(cell);
  // A shipped bot plans from what it remembers seeing (15, #230), so it is given the cell's sighting.
  p.discovery.items = new Map([[cell.id, { ...cell }]]);
  return { s, p };
}

test('collecting a healing intent leaves public state untouched', () => {
  const { s, p } = healing();
  const before = publicState(s, p);
  const intent = collectBotIntent(s, p);
  assert.equal(intent.input.slot, 0);
  assert.equal(intent.utilitySlot, 0);
  assert.equal(intent.discardSlot, undefined);
  assert.deepEqual(publicState(s, p), before);
});

test('collecting a cell pursuit intent reports the discard slot without dropping', () => {
  const { s, p } = pursuing();
  const before = publicState(s, p);
  const intent = collectBotIntent(s, p);
  assert.equal(intent.discardSlot, 1);
  assert.deepEqual(publicState(s, p), before);
});
