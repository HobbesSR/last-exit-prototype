import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step } from '../../shared/simulation.ts';

test('with combat damage neutralized, bots complete the cell objective and fill all three pods through the maze', () => {
  for (const seed of [1, 9, 4217]) {
    const s = createGame(seed); s.map.traps = [];
    // Isolate objective navigation from the separately tested proactive PvP and finite ammo.
    for (const p of s.players) if (p.role === 'gladiator') p.status = 'eliminated'; else p.shield = 1000000;
    while (s.phase === 'live') step(s);
    assert.equal(s.players.filter(p => p.status === 'escaped').length, 3, `seed ${seed}`);
  }
});
