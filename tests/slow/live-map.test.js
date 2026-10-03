import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap } from '../../map/live.ts';
import { createGame, step } from '../../shared/simulation.ts';

test('combat-neutralized bots fill all three extraction slots on representative live chain maps', () => {
  for (const seed of [1, 9, 4217]) {
    const game = createGame(seed, generateLiveMap(seed));
    game.map.traps = [];
    for (const player of game.players) {
      if (player.role === 'gladiator') player.status = 'eliminated';
      else player.shield = 1000000;
    }
    while (game.phase === 'live') step(game);
    assert.equal(game.slots, 0, `seed ${seed}: three extraction slots filled`);
    assert.equal(game.players.filter(player => player.status === 'escaped').length, 3, `seed ${seed}: three contestants escaped`);
  }
});
