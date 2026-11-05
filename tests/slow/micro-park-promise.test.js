import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { cellsOf } from '../helpers/cells.js';
import { SEEDS, THOROUGH, brief, blockers, assertParkPromise, assertClumpSpacing, assertParkKinds, assertPiecesAtSizes } from '../helpers/park-fixtures.js';

// The fast tier's tests/micro-park.test.js runs the first seed of the promise and cell-size sweeps
// and two of the clump and kind sweeps (31, #760, #807).
test('a park region keeps the portal promise over seeds, masks and parameters', () => assertParkPromise(SEEDS));
test('clumps keep an aisle from each other and respect portal margins', () => assertClumpSpacing(SEEDS));
test('a park is its own type, with trees and hedge fronts and no buildings', () => assertParkKinds(SEEDS));
test('pieces keep valid, in-footprint geometry at small and large cell sizes', () => assertPiecesAtSizes(SEEDS));

// 36 portals with hedge fronts took about 13 s (types-62), so it runs in the slow tier.
test('a rectangular park past 32 portals keeps every portal reachable', () => {
  // Boundary spacing alone let a clump stand flush over a side portal's approach on these
  // seeds (#361); the nearby-portal route tree keeps them open.
  const cells = cellsOf(36, 72), portals = [];
  for (let k = 3; k < 36; k += 6) portals.push({ id: `n${k}`, axis: 'h', x: k, y: 0, length: 3 }, { id: `s${k}`, axis: 'h', x: k, y: 72, length: 3 });
  for (let k = 3; k < 72; k += 6) portals.push({ id: `w${k}`, axis: 'v', x: 0, y: k, length: 3 }, { id: `e${k}`, axis: 'v', x: 36, y: k, length: 3 });
  assert.equal(portals.length, 36);
  for (const seed of [5, 6]) {
    const input = brief('many-portals', seed, cells, portals), result = buildRegion(input);
    // A connected pocket intentionally replaces several scatter slots (types-56).
    assert.ok(result.manifest.clumps > 20 || (result.manifest.pockets === 1 && result.manifest.clumps > 10),
      `seed ${seed} still composes scatter or a pocket: ${JSON.stringify(result.manifest)}`);
    assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }, THOROUGH).errors, [], `seed ${seed}`);
  }
});

