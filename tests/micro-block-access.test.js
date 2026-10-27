import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { MASKS, SEEDS, SIZE, brief } from './helpers/block-masks.js';
import { standNear } from './helpers/stands.js';

const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('every lot keeps its own promise between its frontages, and a hunter reaches it from the block\'s portals', () => {
  const radius = hunterClearance(SIZE);
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 1)) {
    const input = brief(name, seed, cells, portals), result = buildRegion(input), access = createAccessMask(input), shapes = blockers(result);
    const near = standNear(input);
    for (const lot of planBlock(input).lots) {
      const own = buildRegion(lot);
      assert.deepEqual(validatePortalReach({ ...lot, blockers: blockers(own) }).errors, [], `${name} ${seed}: ${lot.id} (${lot.type})`);
      // Its own promise joins the frontages, so one stand inside them stands for the lot.
      const point = portalStands(lot)[0].points[0];
      assert.ok(findRegionRoute(access, shapes, near(point), point, radius), `${name} ${seed}: ${lot.id} (${lot.type}) at ${point.x},${point.y}`);
    }
  }
});
