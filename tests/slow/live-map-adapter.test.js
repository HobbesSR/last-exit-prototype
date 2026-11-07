import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt } from '../../map/live.ts';
import { generate } from '../../map/chain.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createMatch } from '../../server/match.js';

// Moved from tests/live-map-adapter.test.js (#849): three game maps, slow-tier work (31). That seed 1's
// map is the one a room generates is held here; tests/live-map.test.js leans on it.
const live = () => liveMapFromBuilt(1, composeRegions(generate('1', liveChainParams()).results));

test('the adapter is deterministic, content-sized, and is the default match map', () => {
  // The match generates its own map, a second generation from the seed: equal, so deterministic and the default.
  assert.deepEqual(createMatch(1).map(), live());
  const twoHunters = contentById('content-1');
  const earlier = generateLiveMap(1, twoHunters);
  assert.equal(earlier.hunterSpawns.length, twoHunters.roster.gladiators.length);
  assert.equal(earlier.spawns.length, twoHunters.roster.contestants.length);
});
