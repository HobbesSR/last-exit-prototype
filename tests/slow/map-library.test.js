import test from 'node:test';
import assert from 'node:assert/strict';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { diagnoseBuiltMap } from '../../map/micro/diagnose.ts';
import { ENGINES, checkLibraryMap, libraryMap } from '../helpers/map-library-game.js';

/**
 * B4 (#97), the issue's acceptance: maps from the library pass step 8's measurement over a
 * bounded seed batch. The portal diagnostic costs about 45 s a game map, nearly all on the
 * one large open region, so it runs on one seed, which also carries the default contestant
 * count's sites, content and core element routes (the fast file checks 24, #807).
 */
const SEEDS = Array.from({ length: 20 }, (_, i) => `library-${i}`);

test('25 game-size maps report no defects: 20 with 8 contestants and 5 with 24', () => {
  for (const contestantCount of [8, 24]) for (const seed of SEEDS.slice(0, contestantCount === 8 ? 20 : 5)) {
    assert.deepEqual(mapViews(libraryMap(seed, contestantCount), ENGINES.compose).report.defects, [], `${seed} with ${contestantCount}`);
  }
});

test('a game-size map sites and reaches every core element for 8 contestants, and every region keeps its portal promise', () => {
  const map = libraryMap(SEEDS[0]);
  // The diagnosis below is the thorough portal check on every region, open ones too.
  checkLibraryMap(map, SEEDS[0], 8, { reach: false });
  assert.deepEqual(diagnoseBuiltMap(mapViews(map, ENGINES.compose).built), []);
});
