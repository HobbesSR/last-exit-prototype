import test from 'node:test';
import assert from 'node:assert/strict';
import { generateChainMap, mapViews } from '../../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../../map/micro/region-types.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { diagnoseBuiltMap } from '../../map/micro/diagnose.ts';

/**
 * B4 (#97), the issue's acceptance: maps from the library pass step 8's measurement over a
 * bounded seed batch. The portal diagnostic costs about 45 s a game map, nearly all on the
 * one large open region, so it runs on one seed.
 */
import { CHAIN_LIBRARY as LIBRARY } from '../../map/chain.ts';
const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const ENGINES = { version: REGION_TYPES_VERSION, build: brief => buildRegion(brief), compose: composeRegions };
const SEEDS = Array.from({ length: 20 }, (_, i) => `library-${i}`);

test('25 game-size maps report no defects: 20 with 8 contestants and 5 with 24', () => {
  for (const contestantCount of [8, 24]) for (const seed of SEEDS.slice(0, contestantCount === 8 ? 20 : 5)) {
    const map = generateChainMap(seed, { ...GAME, contestantCount }, LIBRARY, 48, ENGINES);
    assert.deepEqual(mapViews(map, ENGINES.compose).report.defects, [], `${seed} with ${contestantCount}`);
  }
});

test('every region of a game-size map keeps its portal promise', () => {
  const map = generateChainMap(SEEDS[0], GAME, LIBRARY, 48, ENGINES);
  assert.deepEqual(diagnoseBuiltMap(mapViews(map, ENGINES.compose).built), []);
});
