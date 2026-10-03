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
 * they meet. The fixture library's open ground is `cover`, its huts are `hut`, its departure
 * is `departure`, and its other region types are bound to the example builders, so that
 * saving carries real geometry. A fixture hut is a 2 × 3 region, too small for a house, so
 * `hut` leaves it `open`, the last resort (17 M24). A playground map keeps the report clean: at game size the fixture's
 * arrival is too small for its spawns, and its open ground has one-cell necks.
 */
const LIBRARY = JSON.parse(readFileSync(new URL('../map/macro/tests/fixtures/chain-placement-library.json', import.meta.url), 'utf8'));
const PLAYGROUND = { mode: 'playground', zoneWidth: 2, zoneHeight: 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const REGISTRY = {
  'open-field': REGION_TYPES.cover,
  hut: REGION_TYPES.hut,
  arrival: REGION_TYPES['example-entry'],
  departure: REGION_TYPES.departure,
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
    error => error.message.includes(`its results were built by strategies ${ENGINES.version}, not ${REGION_TYPES_VERSION}`));
});

test('the accessor composes with the game, and both diagnostics read the same built map', () => {
  const views = mapViews(map, ENGINES.compose);
  assert.equal(views.built.regions.length, views.briefs.length);
  assert.deepEqual(views.built, composeRegions(map.results));
  // Macro's report reads sites and briefs; the game's diagnostic reads geometry. Neither is saved.
  assert.deepEqual(views.report.defects, []);
  assert.deepEqual(diagnoseBuiltMap(views.built), []);
});

test('a game-size chain map builds, with its open ground as cover or open', () => {
  // The example builder took about 30 s on this open ground and then threw (#96).
  const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
  for (const ground of ['cover', 'open']) {
    const engines = { ...ENGINES, build: brief => buildRegion(brief, { ...REGISTRY, 'open-field': REGION_TYPES[ground] }) };
    for (const seed of ['placement-1', 'placement-2', 'placement-3']) {
      const game = generateChainMap(seed, GAME, LIBRARY, 48, engines), views = mapViews(game, engines.compose);
      assert.equal(views.built.regions.length, views.briefs.length);
      assert.deepEqual(decodeChainMap(JSON.parse(chainMapToJson(game, { results: false })), LIBRARY, engines), game);
      const field = game.results.filter(r => r.brief.type === 'open-field');
      assert.ok(field.length && field.every(r => ground === 'cover' ? r.elements.length : !r.elements.length && !r.loot.length), `${ground} ${seed}`);
    }
  }
});
