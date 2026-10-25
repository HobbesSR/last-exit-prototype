import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap } from '../../map/live.ts';
import { createPhysicsGame, disposePhysics, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';

test('P8 contestants complete a combat-neutralized live-chain match with solid actor contact', async () => {
  const content = contentById('content-physics-8');
  const game = await createPhysicsGame(4217, generateLiveMap(4217, content), content);
  try {
    game.map.traps = [];
    for (const player of game.players) {
      if (player.role === 'gladiator') player.status = 'eliminated';
      else player.shield = 1000000;
    }
    while (game.phase === 'live') step(game);
    assert.equal(game.slots, 0, `P8 seed 4217: escaped=${game.players.filter(p => p.status === 'escaped').length}, tick=${game.tick}`);
  } finally { disposePhysics(game); }
});
