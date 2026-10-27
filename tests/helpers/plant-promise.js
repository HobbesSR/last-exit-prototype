import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { SIZE, brief, MASKS, blockers } from './plant-fixtures.js';

/**
 * A plant keeps the portal promise on every mask of `plant-fixtures.js` at each of `seeds`, under
 * each parameter set. The fast tier runs two seeds and `tests/slow/micro-plant-promise.test.js`
 * all eight, which took 4.9 of the file's 10.4 s (31, #543).
 */
export function assertPlantPromise(seeds) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds)
    for (const parameters of [undefined, { density: 1, shed: 0 }, { density: 1, shed: 1 }, { density: 0.3 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      if (name !== 'yard' && parameters?.density === 1) assert.ok(result.elements.length > 0, `${name} seed ${seed} stood machines or a shed`);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
}
