import test from 'node:test';
import assert from 'node:assert/strict';
import { chainMapToBson, chainMapToJson } from '../../map/macro/src/chain/saving.ts';
import { CHAIN_LIBRARY, checkMap, generate, readMap, validateLibrary } from '../../map/tools/core.ts';
import { GAME_ENGINES } from '../../map/tools/engines.ts';
import { REGION_TYPES_VERSION } from '../../map/micro/region-types.ts';
import { GAME, checkLibraryMap } from '../helpers/map-library-game.js';

// Moved from tests/map-tools.test.js (#849): a 12 x 6 game map, slow-tier work (31).

test('the tools build with the game registry and the chain library', () => {
  assert.equal(GAME_ENGINES.version, REGION_TYPES_VERSION);
  assert.deepEqual(validateLibrary(CHAIN_LIBRARY), { valid: true, errors: [] });
  const map = generate('tools-game');
  assert.equal(map.layout.params.mode, 'game');
  assert.equal(map.build, REGION_TYPES_VERSION);
  const check = checkMap(map);
  assert.equal(check.valid, true, JSON.stringify(check.defects));
  assert.equal(check.brokenPromises, undefined, 'the slow diagnostic runs only on request');
  // The default contestant count's fast library witness reads this map (about 10 ms of routes):
  // its sites, built huts, cover and rubble, and routes to core elements. `map-library` checks
  // the portal search on a 24-contestant map (#807).
  assert.equal(map.layout.params.contestantCount, GAME.contestantCount);
  checkLibraryMap(map, 'tools-game', GAME.contestantCount, { reach: false });
  // Saved whole in either encoding, it reads back the same map. Reading a game map from its
  // Layout alone rebuilds every region (2.3 s); `map-container` does that with these engines,
  // and the custom save below reads a Layout through `readMap` (#807).
  for (const saved of [JSON.parse(chainMapToJson(map)), chainMapToBson(map)])
    assert.deepEqual(readMap(saved), map);
});
