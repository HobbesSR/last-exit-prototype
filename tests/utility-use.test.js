import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord } from '../shared/simulation.ts';
import { utilityApplies, utilityOutcome } from '../shared/simulation/combat.ts';
import { collectBotIntent } from '../shared/simulation/bots.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';

const map = () => arena({ cols: 4, rows: 3, spawns: [{ x: 200, y: 200 }, { x: 500, y: 200 }] }).map;
const content = () => ({ ...defaultContent(), roster: { contestants: ['A', 'B'], gladiators: [] } });
// Intent preview needs only records; the tick core tests actual utility use.
const bareRecord = () => createGameRecord(438, map(), content());

test('utility preview caps effects and refuses full-state use without mutation', () => {
  const s = bareRecord(), p = s.players[0];
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
  }
  assert.equal(utilityOutcome(p, { kind: 'cell', charge: 0 }), null);
  assert.equal(utilityApplies(p, null), false);
});

test('bot intent respects utility applicability and cooldown without consuming items', () => {
  const s = bareRecord(), p = s.players[0];
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
