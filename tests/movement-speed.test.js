import assert from 'node:assert/strict';
import test from 'node:test';
import { movementSpeed } from '../shared/movement.ts';

test('movement speed retains legacy role, boost, stun, and sneak combinations', () => {
  // Exact outputs also guard the order of the floating-point multiplications.
  const cases = [
    ['contestant', 0, 0, false, 9, 180],
    ['contestant', 0, 0, true, 4.95, 99.00000000000001],
    ['contestant', 0, 2, false, 3.15, 62.99999999999999],
    ['contestant', 0, 2, true, 1.7325000000000002, 34.65],
    ['contestant', 3, 0, false, 13.049999999999999, 261],
    ['contestant', 3, 0, true, 7.1775, 143.55],
    ['contestant', 3, 2, false, 4.567499999999999, 91.35],
    ['contestant', 3, 2, true, 2.5121249999999997, 50.2425],
    ['gladiator', 0, 0, false, 8, 160],
    ['gladiator', 0, 0, true, 8, 160],
    ['gladiator', 0, 2, false, 2.8, 56],
    ['gladiator', 0, 2, true, 2.8, 56],
    ['gladiator', 3, 0, false, 12, 240],
    ['gladiator', 3, 0, true, 12, 240],
    ['gladiator', 3, 2, false, 4.199999999999999, 84],
    ['gladiator', 3, 2, true, 4.199999999999999, 84],
  ];
  for (const [role, boost, stun, sneak, expected, scaled] of cases) {
    assert.equal(movementSpeed({ role, boost, stun }, { sneak }), expected,
      `${role}, boost=${boost}, stun=${stun}, sneak=${sneak}`);
    assert.equal(movementSpeed({ role, boost, stun }, { sneak }, 20), scaled,
      `${role}, boost=${boost}, stun=${stun}, sneak=${sneak}, scale=20`);
  }
  assert.equal(movementSpeed({ role: 'contestant', boost: 0, stun: 0 }, {}), 9);
});
