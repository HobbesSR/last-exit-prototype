import assert from 'node:assert/strict';
import { generateChainMap, mapViews } from '../../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../../map/micro/region-types.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../../map/micro/geometry.ts';
import { microMetrics } from '../../map/micro/metrics.ts';
import { portalStands, validatePortalReach } from '../../map/micro/portals.ts';
import { CHAIN_LIBRARY } from '../../map/chain.ts';

/**
 * The chain's library at the game size, built by the game's own strategies (B4, #97). The fast
 * `map-library` checks one map with every claim; the slow one checks the default contestant
 * count on the map it diagnoses, so each claim reads a map some file already generates (#807).
 */
export const GAME = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
export const ENGINES = { version: REGION_TYPES_VERSION, build: brief => buildRegion(brief), compose: composeRegions };
export const LIBRARY = CHAIN_LIBRARY;

export const libraryMap = (seed, contestantCount = GAME.contestantCount) =>
  generateChainMap(seed, { ...GAME, contestantCount }, LIBRARY, 48, ENGINES);

/**
 * A game-size map sites its core elements for `contestantCount`, built real content, and
 * reaches every core element from a portal. With `reach`, every non-open region also keeps
 * its portal promise under the thorough search; leave it off where `diagnoseBuiltMap` runs.
 */
export function checkLibraryMap(map, seed, contestantCount, { reach = true } = {}) {
  assert.deepEqual(mapViews(map, ENGINES.compose).report.defects, []);
  const sites = map.results.flatMap(result => result.coreElements.map(site => site.kind));
  const count = kind => sites.filter(site => site === kind).length;
  assert.deepEqual([count('spawn'), count('exit'), count('hunter-spawn'), count('charger'), count('warp')],
    [contestantCount, GAME.exitCount, GAME.hunterCount, 3, 6]);
  // Exercise built content, not just class names or manifest counts (54).
  const huts = map.results.filter(result => result.brief.type === 'hut');
  assert.ok(huts.length && huts.every(hut => hut.elements.some(element =>
    element.template.encloses && element.template.parts.some(part => part.part === 'gate'))), 'every hut region built a house with a door');
  for (const type of ['cover', 'rubble']) assert.ok(map.results.some(result =>
    result.brief.type === type && result.elements.length), `${type} places actual geometry`);
  for (const result of map.results.filter(result => result.brief.type !== 'open')) {
    const { brief } = result, blockers = result.elements.flatMap(element => elementShapes(element));
    // Thorough, as the map diagnosis is: cord adopters such as park pass between pieces off the grid (20.10).
    if (reach) assert.deepEqual(validatePortalReach({ ...brief, blockers }, { search: 'thorough' }).errors, [], `${seed} ${brief.type} ${brief.id}`);
    // Reaching a site from the first portal is the core element strategies' own siting rule
    // (54), not the portal promise: a region's interior is its builder's business (51 principle 9).
    if (!result.coreElements.length) continue;
    const mask = createAccessMask(brief), root = portalStands(brief)[0]?.points[0];
    assert.ok(root, `${brief.type} has an entrance`);
    const { clearance } = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' });
    for (const site of result.coreElements) {
      const radius = site.kind === 'hunter-spawn' || site.kind === 'warp' ? clearance.hunter : clearance.contestant;
      assert.ok(findRegionRoute(mask, blockers, root, site, radius), `${seed} ${site.kind} is reachable inside ${brief.id}`);
    }
  }
}
