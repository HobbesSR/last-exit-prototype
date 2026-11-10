import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveRecipeMismatch, LIVE_ZONE_SIZES } from '../../map/live.ts';
import { generateMacro } from '../../map/chain.ts';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { builtMapFrame } from '../../map/micro/adapter.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { createPhysicsGame, disposePhysics, step } from '../../shared/simulation.ts';

// Two maps: the claim is that the mechanism completes on a chain map, and more seeds only sample
// for stalls. 4217, the third seed here until #822, is the map physics-navigation plays. On the
// shipped content and its engine (#920).
test('combat-neutralized bots fill all three extraction slots on representative live chain maps', async () => {
  const content = defaultContent();
  for (const seed of [1, 9]) {
    const game = await createPhysicsGame(seed, generateLiveMap(seed, content), content);
    try {
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
    } finally { disposePhysics(game); }
  }
});

// Macro alone (#821): the recipe is all the map states, and the frame the adapter would give the
// built map is its briefs' cell extent. Building and converting the 1,049 regions took 18 s. No
// per-run test builds or converts a composed 24 x 12 map any more: micro-large-briefs builds each
// type's extreme stored brief at the larger sizes (13 types, not transit, arrival or departure),
// not these briefs, and the adapter has no size branch beyond the frame (#822).
test('at the larger authored size macro states a room recipe, and its briefs give the room frame', () => {
  const size = LIVE_ZONE_SIZES[1];
  const chain = generateMacro('1', liveChainParams(defaultContent(), size));
  assert.deepEqual(liveRecipeMismatch(chain), []);
  const { width, height } = builtMapFrame({ cellSize: chain.cellSize, regions: mapViews(chain).briefs.map(brief => ({ brief })) });
  assert.deepEqual([width, height], [34560, 17280]);
});
