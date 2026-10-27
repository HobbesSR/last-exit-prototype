import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { elementShapes } from '../../map/micro/geometry.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { planBlock } from '../../map/micro/strategies/block.ts';
import { MASKS, brief } from './block-masks.js';

/**
 * A block plans lots and keeps the portal promise on every mask of `block-masks.js` at each of
 * `seeds`. The reach checks cost most of it, the deep mask's alone 5 s of the 12 that all four
 * seeds take, so the fast tier runs one seed and `tests/slow/micro-block-promise.test.js` all
 * of them (31, #543).
 */
export function assertBlockPromise(seeds) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds) {
    const input = brief(name, seed, cells, portals), result = buildRegion(input);
    assert.ok(planBlock(input).lots.length >= 2, `${name} seed ${seed} has lots`);
    const check = validatePortalReach({ ...result.brief, blockers: result.elements.flatMap(element => elementShapes(element)) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
}
