import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, stateOf } from '../../shared/simulation.ts';
import { stepGame } from '../../shared/simulation/tick.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { generatedMap } from '../helpers/room-harness.js';
import { rounds } from '../helpers/rounds.js';

// Moved from tests/reloading.test.js (#1071): a whole bot match is slow-tier work (31). The fast file
// keeps the scripted reload, conservation and recording cases.
test('bots reload from their reserves, and a whole bot match conserves every round it does not fire', async t => {
  const s = await createGame(17, generatedMap(9), contentById('content-ammo-1'));
  t.after(() => disposePhysics(s));
  // The game is the start's arrangement until it is stepped; after that the rounds are the core's records.
  const total = g => ['pistol', 'rifle', 'shell'].reduce((n, family) => n + rounds(g, family), 0);
  const start = total(s);
  let reloads = 0, shots = 0;
  for (let i = 0; i < 1500 && s.phase === 'live'; i++) {
    const tick = stepGame(s);
    for (const { fact } of tick.changes.events) {
      // The core emits one shot fact per spent round, including scattergun volleys.
      if (fact.kind === 'shotFired') shots++;
      else if (fact.kind === 'reloaded') reloads++;
    }
  }
  assert.ok(reloads > 0, 'some bot reloaded');
  assert.ok(shots > 0, 'bots fired');
  assert.equal(total({ content: s.content, ...stateOf(s) }), start - shots);
});
