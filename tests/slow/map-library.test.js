import test from 'node:test';
import assert from 'node:assert/strict';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { diagnoseBuiltMap } from '../../map/micro/diagnose.ts';
import { ENGINES, checkLibraryMap, checkReportBatch, libraryMap } from '../helpers/map-library-game.js';

/**
 * B4 (#97), the issue's acceptance: maps from the library pass step 8's measurement over a
 * bounded seed batch. The portal diagnostic runs on one seed, which also carries the default
 * contestant count's sites, content and core element routes (the fast file checks 24). The
 * twenty 8-contestant maps of the batch are in `map-library-8` and `map-library-8-tail`, so
 * each file stays under the slow budget (#807).
 */
test('5 game-size maps with 24 contestants report no defects', () => {
  checkReportBatch([0, 1, 2, 3, 4], 24);
});

test('a game-size map sites and reaches every core element for 8 contestants, and every region keeps its portal promise', () => {
  const map = libraryMap('library-0');
  // The diagnosis below is the thorough portal check on every region, open ones too.
  checkLibraryMap(map, 'library-0', 8, { reach: false });
  assert.deepEqual(diagnoseBuiltMap(mapViews(map, ENGINES.compose).built), []);
});
