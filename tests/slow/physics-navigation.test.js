import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap } from '../../map/live.ts';
import { createGame, disposePhysics, step } from '../../shared/simulation.ts';
import { stateOf } from '../../shared/simulation/tick.ts';
import { contentById } from '../../shared/simulation/content.ts';

test('contestants complete a combat-neutralized live-chain match with solid actor contact', async () => {
  const content = contentById('content-6');
  const game = await createGame(4217, generateLiveMap(4217, content), content);
  try {
    game.traps = [];
    for (const player of game.players) {
      if (player.role === 'gladiator') player.status = 'eliminated';
      else player.shield = 1000000;
    }
    while (game.phase === 'live') step(game);
    const state = stateOf(game);
    assert.equal(state.slots, 0, `seed 4217: escaped=${state.players.filter(p => p.status === 'escaped').length}, tick=${game.tick}`);
  } finally { disposePhysics(game); }
});
