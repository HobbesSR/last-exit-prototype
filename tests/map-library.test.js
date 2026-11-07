import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { REGION_TYPES } from '../map/micro/region-types.ts';
import { CHAIN_LIBRARIES, validateLibrary as validateGameLibrary } from '../map/chain.ts';

/**
 * B4 (#97): the chain's bundled libraries are valid for the game. Maps built from them,
 * with the game's own strategies, are slow-tier work (31, #849): tests/slow/map-library.test.js
 * checks one at 24 contestants and one at the default count, diagnosed whole.
 */
test('every class in each bundled library names a region type the game registers', () => {
  for (const library of CHAIN_LIBRARIES) {
    assert.deepEqual(validateLibrary(library, new Set(Object.keys(REGION_TYPES))), { valid: true, errors: [] }, library.name);
  }
});

test('each bundled library is valid for the game under matched passability (#849)', () => {
  for (const library of CHAIN_LIBRARIES) {
    assert.deepEqual(validateGameLibrary(library).errors, [], library.name);
    assert.equal(library.passabilityRules, 'matched', library.name);
    // Weight 0 is retired in bundled content: `fillable: false` keeps a tile to set pieces (17.2.2).
    assert.deepEqual(library.tiles.filter(tile => !(tile.weight > 0)).map(tile => tile.id), [], library.name);
  }
});
