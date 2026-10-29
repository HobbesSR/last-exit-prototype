import { CHAIN_LIBRARIES } from '../../../map/chain.ts';
import { generateChainMap, mapViews } from '../../../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION, buildRegion } from '../../../map/micro/region-types.ts';
import { measureFill } from '../../../map/micro/fill.ts';
import { validatePortalReach } from '../../../map/micro/portals.ts';
import { elementShapes } from '../../../map/micro/geometry.ts';
import { composeRegions } from '../../../map/micro/compose.ts';

const samples = [];
for (const library of CHAIN_LIBRARIES) {
  const seed = `size-${library.zoneWidth}-1`;
  const params = {
    zoneWidth: library.zoneWidth,
    zoneHeight: library.zoneHeight,
    exitCount: 2,
    contestantCount: 8,
    hunterCount: 3,
    lootChance: 0.04,
    lootTierStep: 0.09,
  };
  const map = generateChainMap(seed, params, library, 48, {
    version: REGION_TYPES_VERSION,
    build: buildRegion,
    compose: composeRegions,
  });
  const report = mapViews(map, composeRegions).report;
  const huts = map.results.filter(result => result.brief.type === 'hut').map(result => {
    const fill = measureFill(result.brief, result.elements);
    const reach = validatePortalReach({
      ...result.brief,
      blockers: result.elements.flatMap(element => elementShapes(element)),
    });
    const houses = result.elements.filter(element => element.template.encloses);
    return {
      id: result.brief.id,
      cells: result.brief.cells.length,
      fillCells: result.brief.fillCells.length,
      houseCount: houses.length,
      houseBounds: houses.map(house => ({ x: house.x, y: house.y, w: house.template.w, h: house.template.h })),
      freeCells: fill.freeCells,
      occupiedCells: fill.cells - fill.freeCells,
      largest: fill.largest,
      rectangles: fill.rectangles.length,
      reachErrors: reach.errors,
    };
  });
  samples.push({ seed, zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight,
    defects: report.defects, huts });
}
process.stdout.write(`${JSON.stringify(samples, null, 2)}\n`);
