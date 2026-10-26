import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt, liveRecipeMismatch, LIVE_ZONE_SIZES } from '../../map/live.ts';
import { generate } from '../../map/chain.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { createGame, step } from '../../shared/simulation.ts';

test('combat-neutralized bots fill all three extraction slots on representative live chain maps', () => {
  for (const seed of [1, 9, 4217]) {
    const game = createGame(seed, generateLiveMap(seed));
    game.map.traps = [];
    for (const player of game.players) {
      if (player.role === 'gladiator') player.status = 'eliminated';
      else player.shield = 1000000;
    }
    // The match ends at its declared duration however play goes, so a stalled one fails here.
    const limit = game.content.durationTicks;
    for (let i = 0; i <= limit && game.phase === 'live'; i++) step(game);
    assert.notEqual(game.phase, 'live', `seed ${seed}: the match ended within its ${limit}-tick duration`);
    assert.equal(game.slots, 0, `seed ${seed}: three extraction slots filled`);
    assert.equal(game.players.filter(player => player.status === 'escaped').length, 3, `seed ${seed}: three contestants escaped`);
  }
});

test('a room can be generated at the larger authored size', () => {
  const size = LIVE_ZONE_SIZES[1];
  const chain = generate('1', liveChainParams(defaultContent(), size));
  assert.deepEqual(liveRecipeMismatch(chain), []);
  const map = liveMapFromBuilt(1, composeRegions(chain.results), defaultContent());
  assert.deepEqual([map.width, map.height], [34560, 17280]);
});
