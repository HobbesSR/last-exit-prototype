import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateChainMap, mapViews } from '../map/macro/src/chain/map.ts';
import { chainMapToBson, chainMapToJson, decodeChainMap, readChainMap } from '../map/macro/src/chain/saving.ts';
import { buildRegion, REGION_TYPES, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { diagnoseBuiltMap } from '../map/micro/diagnose.ts';

/**
 * 51 step 9 with the game's own engines: macro's chain map, built and composed by the
 * game's strategies. Macro and micro don't import each other (50), so this test is where
 * they meet. The fixture library's region types are bound to the example builders, except
 * its huts: a hut is a narrow region with no standing room behind its portals, so it gets
 * an empty strategy, which keeps the portal promise by placing nothing. A playground map
 * keeps it small, since the example builders can't yet fill the fixture's game-sized open
 * ground.
 */
const LIBRARY = JSON.parse(readFileSync(new URL('../map/macro/tests/fixtures/chain-placement-library.json', import.meta.url), 'utf8'));
const PLAYGROUND = { mode: 'playground', zoneWidth: 2, zoneHeight: 2, exitCount: 2, contestantCount: 8, lootChance: 0.04, lootTierStep: 0.09 };
const REGISTRY = {
  'open-field': REGION_TYPES['example-open'],
  hut: brief => ({ version: 'region-2', brief: structuredClone(brief), elements: [], coreElements: [], loot: [], manifest: {} }),
  arrival: REGION_TYPES['example-entry'],
  departure: REGION_TYPES['example-entry'],
  charging: REGION_TYPES['example-depot'],
};
const ENGINES = { version: `fixture-${REGION_TYPES_VERSION}`, build: brief => buildRegion(brief, REGISTRY), compose: composeRegions };
const map = generateChainMap('placement-1', PLAYGROUND, LIBRARY, 48, ENGINES);

test('a chain map built by the game round-trips, whole or from its Layout alone', () => {
  assert.ok(map.results.some(result => result.elements.length), 'the builders placed geometry');
  assert.deepEqual(decodeChainMap(JSON.parse(chainMapToJson(map)), LIBRARY), map);
  assert.deepEqual(readChainMap(chainMapToBson(map), LIBRARY), map);
  assert.deepEqual(decodeChainMap(JSON.parse(chainMapToJson(map, { results: false })), LIBRARY, ENGINES), map);
  assert.throws(() => decodeChainMap(JSON.parse(chainMapToJson(map, { results: false })), LIBRARY, { ...ENGINES, version: REGION_TYPES_VERSION }),
    /its results were built by strategies fixture-examples-1, not examples-1/);
});

test('the accessor composes with the game, and both diagnostics read the same built map', () => {
  const views = mapViews(map, ENGINES.compose);
  assert.equal(views.built.regions.length, views.briefs.length);
  assert.deepEqual(views.built, composeRegions(map.results));
  // Macro's report reads sites and briefs; the game's diagnostic reads geometry. Neither is saved.
  assert.deepEqual(views.report.defects, []);
  assert.deepEqual(diagnoseBuiltMap(views.built), []);
});
