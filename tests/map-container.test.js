import test from 'node:test';
import assert from 'node:assert/strict';
import { generateChainMap, mapViews } from '../map/macro/src/chain/map.ts';
import { chainMapToBson, chainMapToJson, decodeChainMap, readChainMap } from '../map/macro/src/chain/saving.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { composeRegions } from '../map/micro/compose.ts';

/**
 * 51 step 9 with the chain's authored library and the game's own strategies. Macro and
 * micro don't import each other (50), so this test is where they meet. Playground mode
 * intentionally places no set pieces; use a game-size map to exercise real core elements.
 */
import { CHAIN_LIBRARY as LIBRARY } from '../map/chain.ts';
const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const ENGINES = { version: REGION_TYPES_VERSION, build: brief => buildRegion(brief), compose: composeRegions };
const map = generateChainMap('library-container', GAME, LIBRARY, 48, ENGINES);

test('a chain map built by the game round-trips, whole or from its Layout alone', () => {
  assert.ok(map.results.some(result => result.elements.length), 'the builders placed geometry');
  assert.deepEqual(decodeChainMap(JSON.parse(chainMapToJson(map)), LIBRARY), map);
  assert.deepEqual(readChainMap(chainMapToBson(map), LIBRARY), map);
  const layoutOnly = JSON.parse(chainMapToJson(map, { results: false }));
  assert.deepEqual(decodeChainMap(layoutOnly, LIBRARY, ENGINES), map);
  assert.throws(() => decodeChainMap(layoutOnly, LIBRARY, { ...ENGINES, version: 'older-types' }),
    error => error.message.includes(`its results were built by strategies ${REGION_TYPES_VERSION}, not older-types`));
});

test('the accessor composes with the game and reports the authored map clean', () => {
  const views = mapViews(map, ENGINES.compose);
  assert.equal(views.built.regions.length, views.briefs.length);
  assert.deepEqual(views.built, composeRegions(map.results));
  assert.deepEqual(views.report.defects, []);
});
