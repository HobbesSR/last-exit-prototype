import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../shared/simulation.ts';
import { attack, utilityApplies, utilityOutcome } from '../shared/simulation/combat.ts';
import { collectBotIntent } from '../shared/simulation/bots.ts';

test('utility preview and actual attack share capped effects and full-state refusal', () => {
  const s = createGame(438), p = s.players[0];
  for (const [kind, hp, shield, expected] of [
    ['med', 40, 10, { hp: 80, shield: 10 }],
    ['med', 95, 10, { hp: 100, shield: 10 }],
    ['med', 100, 10, null],
    ['shield', 40, 40, { hp: 40, shield: 70 }],
    ['shield', 40, 70, { hp: 40, shield: 75 }],
    ['shield', 40, 75, null],
  ]) {
    Object.assign(p, { hp, maxHp: 100, shield, attackCd: 0, selectedSlot: 0 });
    p.inventory = [{ kind, count: 2 }, null, null, null, null, null];
    const before = structuredClone(p);
    assert.equal(utilityApplies(p, p.inventory[0]), expected !== null);
    assert.deepEqual(utilityOutcome(p, p.inventory[0]), expected);
    assert.deepEqual(p, before, 'preview leaves all gameplay state untouched');
    attack(s, p);
    assert.deepEqual({ hp: p.hp, shield: p.shield }, expected ?? { hp, shield });
    assert.equal(p.inventory[0].count, expected ? 1 : 2);
    assert.equal(p.attackCd > 0, expected !== null);
  }
  assert.equal(utilityOutcome(p, { kind: 'cell', charge: 0 }), null);
  assert.equal(utilityApplies(p, null), false);
});

test('bot intent respects utility applicability and cooldown without consuming items', () => {
  const s = createGame(438), p = s.players[0];
  for (const actor of s.players) actor.bot = false;
  p.bot = true;
  for (const [hp, maxHp, attackCd, applies] of [[40, 50, 0, true], [40, 50, 1, false], [40, 40, 0, false]]) {
    Object.assign(p, { hp, maxHp, attackCd, selectedSlot: 4 });
    p.inventory = [{ kind: 'med', count: 1 }, null, null, null, null, null];
    const intent = collectBotIntent(s, p);
    assert.equal(intent.utilitySlot, applies ? 0 : undefined);
    assert.equal(p.hp, hp); assert.equal(p.selectedSlot, 4);
    assert.deepEqual(p.inventory[0], { kind: 'med', count: 1 });
  }
});
