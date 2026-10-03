import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLibrary } from '../map/macro/src/chain/library.ts';
import { generateChainMap, mapViews } from '../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { createRegionMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';

/**
 * B4 (#97): the chain's library, built by the game's own strategies with no rebinding.
 * Fast witnesses cover the current and planned contestant counts, the actual structures,
 * core element access and each non-open region's portal promise. The slow suite runs the
 * report batch and a whole-map diagnostic, including the large empty open regions.
 */
const LIBRARY = JSON.parse(readFileSync(new URL('../map/macro/content/chain-library.json', import.meta.url), 'utf8'));
const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const ENGINES = { version: REGION_TYPES_VERSION, build: brief => buildRegion(brief), compose: composeRegions };

test('every class in the library names a region type the game registers', () => {
  assert.deepEqual(validateLibrary(LIBRARY, new Set(Object.keys(REGION_TYPES))), { valid: true, errors: [] });
  for (const cellClass of Object.values(LIBRARY.cellClasses)) assert.ok(!cellClass.regionType.startsWith('example-'));
});

for (const [seed, contestantCount] of [['library-0', 8], ['library-4', 24]]) test(`game-size ${seed} sites and reaches every core element for ${contestantCount} contestants`, () => {
  const params = { ...GAME, contestantCount };
  const map = generateChainMap(seed, params, LIBRARY, 48, ENGINES), views = mapViews(map, ENGINES.compose);
  assert.deepEqual(views.report.defects, []);
  const sites = map.results.flatMap(result => result.coreElements.map(site => site.kind));
  const count = kind => sites.filter(site => site === kind).length;
  assert.deepEqual([count('spawn'), count('exit'), count('hunter-spawn'), count('charger')],
    [contestantCount, GAME.exitCount, GAME.hunterCount, 1]);
  // Exercise built content, not just class names or manifest counts (54).
  const huts = map.results.filter(result => result.brief.type === 'hut');
  assert.ok(huts.length && huts.every(hut => hut.elements.some(element =>
    element.template.encloses && element.template.parts.some(part => part.part === 'gate'))), 'every hut region built a house with a door');
  for (const type of ['cover', 'rubble']) assert.ok(map.results.some(result =>
    result.brief.type === type && result.elements.length), `${type} places actual geometry`);
  for (const result of map.results.filter(result => result.brief.type !== 'open')) {
    const { brief } = result, blockers = result.elements.flatMap(element => elementShapes(element));
    assert.deepEqual(validatePortalReach({ ...brief, blockers }).errors, [], `${seed} ${brief.type} ${brief.id}`);
    if (!result.coreElements.length) continue;
    const mask = createRegionMask(brief), root = portalStands(brief, mask)[0]?.points[0];
    assert.ok(root, `${brief.type} has an entrance`);
    const { clearance } = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' });
    for (const site of result.coreElements) {
      const radius = site.kind === 'hunter-spawn' ? clearance.hunter : clearance.contestant;
      assert.ok(findRegionRoute(mask, blockers, root, site, radius), `${seed} ${site.kind} is reachable inside ${brief.id}`);
    }
  }
});
