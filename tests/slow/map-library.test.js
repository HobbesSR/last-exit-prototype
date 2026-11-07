import test from 'node:test';
import assert from 'node:assert/strict';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { diagnoseBuiltMap } from '../../map/micro/diagnose.ts';
import { ENGINES, checkLibraryMap, libraryMap } from '../helpers/map-library-game.js';

/**
 * B4 (#97), the issue's acceptance: a map from the library passes step 8's measurement. The
 * portal diagnostic runs on one seed, which also carries the default contestant count's sites,
 * content and core element routes (the fast file checks 24). The 25-map report batch that once
 * ran here and in `map-library-8` and `-8-tail` retired (#822): the chain sweep refuses a map
 * whose report has defects, over 161 game-size maps, 120 of them with the batch's parameters
 * but its loot rates, and 20 with 24 contestants.
 */
test('a game-size map sites and reaches every core element for 8 contestants, and every region keeps its portal promise', () => {
  const map = libraryMap('library-0');
  // The diagnosis below is the thorough portal check on every region, open ones too.
  checkLibraryMap(map, 'library-0', 8, { reach: false });
  assert.deepEqual(diagnoseBuiltMap(mapViews(map, ENGINES.compose).built), []);
});

// Moved from tests/map-library.test.js (#849): a game map for 24 contestants, slow-tier work (31).
test('game-size library-4 sites and reaches every core element for 24 contestants', () => {
  checkLibraryMap(libraryMap('library-4', 24), 'library-4', 24);
});
