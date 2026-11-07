import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { REGION_TYPES } from '../map/micro/region-types.ts';
import { CHAIN_LIBRARIES, MATCHED_LIBRARIES, generateMacro, validateLibrary as validateGameLibrary } from '../map/chain.ts';
import { checkLibraryMap, libraryMap } from './helpers/map-library-game.js';

/**
 * B4 (#97): the chain's library, built by the game's own strategies with no rebinding.
 * One fast map, at the planned contestant count, witnesses the structures, core element
 * access and each non-open region's portal promise; it holds more region types than the
 * default count's map and fails if the count is ignored. The slow suite checks the default
 * count on the map it diagnoses whole, and runs the report batch (#807).
 */
test('every class in each bundled library names a region type the game registers', () => {
  for (const library of CHAIN_LIBRARIES) {
    assert.deepEqual(validateLibrary(library, new Set(Object.keys(REGION_TYPES))), { valid: true, errors: [] }, library.name);
  }
});

test('game-size library-4 sites and reaches every core element for 24 contestants', () => {
  checkLibraryMap(libraryMap('library-4', 24), 'library-4', 24);
});

test('each experimental matched library (#849) is valid for the game and places its smallest map', () => {
  for (const library of MATCHED_LIBRARIES) {
    assert.deepEqual(validateGameLibrary(library).errors, [], library.name);
    assert.equal(library.passabilityRules, 'matched');
  }
  const [small] = MATCHED_LIBRARIES;
  const map = generateMacro('matched-1', { zoneWidth: small.zoneWidth, zoneHeight: small.zoneHeight }, small);
  assert.ok(map.layout.slots.length > 0);
  // Bundled libraries are untouched by the experiment.
  assert.equal(CHAIN_LIBRARIES.some(library => library.passabilityRules !== undefined), false);
});
