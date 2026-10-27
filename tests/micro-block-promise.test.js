import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { MASKS, SEEDS, brief } from './helpers/block-masks.js';

// Split from micro-block.test.js to keep each file inside the fast tier's budget (31).
const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('a block keeps the portal promise over seeds and masks', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const input = brief(name, seed, cells, portals), result = buildRegion(input);
    assert.ok(planBlock(input).lots.length >= 2, `${name} seed ${seed} has lots`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
});
