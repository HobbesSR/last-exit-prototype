import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { generateChainMap, mapViews } from '../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { composeRegions } from '../map/micro/compose.ts';

/**
 * B4 (#97): the chain's library, built by the game's own strategies with no rebinding. The
 * fast witness is one game-size map with a clean report. `tests/slow/map-library.test.js`
 * runs the seed batch and the portal diagnostic.
 */
const LIBRARY = JSON.parse(readFileSync(new URL('../map/macro/content/chain-library.json', import.meta.url), 'utf8'));
const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const ENGINES = { version: REGION_TYPES_VERSION, build: brief => buildRegion(brief), compose: composeRegions };

test('every class in the library names a region type the game registers', () => {
  assert.deepEqual(validateLibrary(LIBRARY, new Set(Object.keys(REGION_TYPES))), { valid: true, errors: [] });
  for (const cellClass of Object.values(LIBRARY.cellClasses)) assert.ok(!cellClass.regionType.startsWith('example-'));
});

test('a game-size map from the library builds with a clean report and every core element sited', () => {
  const map = generateChainMap('library-0', GAME, LIBRARY, 48, ENGINES), views = mapViews(map, ENGINES.compose);
  assert.deepEqual(views.report.defects, []);
  const sites = map.results.flatMap(result => result.coreElements.map(site => site.kind));
  const count = kind => sites.filter(site => site === kind).length;
  assert.deepEqual([count('spawn'), count('exit'), count('hunter-spawn'), count('charger')],
    [GAME.contestantCount, GAME.exitCount, GAME.hunterCount, 1]);
  // Huts get their house (54 `hut`): the library's huts are 12 × 12, room for a house and its yard.
  const huts = map.results.filter(result => result.brief.type === 'hut');
  assert.ok(huts.length && huts.every(hut => hut.elements.length), 'every hut region built a house');
});
