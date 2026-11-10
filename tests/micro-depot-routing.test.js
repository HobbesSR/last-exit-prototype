import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { WITNESSES, assertWitnessReach } from './helpers/depot-fixtures.js';

// Each production witness is built once here and shared by the tests below (#807).
const built = new Map();
const forward = ({ witness, brief }) => {
  if (!built.has(witness)) built.set(witness, buildRegion(brief));
  return built.get(witness);
};

test('depot witnesses leave room for warehouses and rows inside the fill margins', () => {
  for (const fixture of WITNESSES) {
    const result = forward(fixture), { witness } = fixture;
    assert.ok(result.manifest.warehouses > 0, `seed ${witness}: warehouses`);
    assert.ok(result.manifest.rows > 0, `seed ${witness}: rows`);
    assert.deepEqual(validateFillConstraints(result.brief, result.elements.flatMap(element => elementShapes(element, true))),
      [], `seed ${witness}: fill margins`);
  }
});

// The 1944-cell witnesses 5 and 8 spend about 1.9 s each in the reach search, so their reach runs
// in tests/slow/micro-depot-sweeps.test.js; the promise's every-run witnesses are the depot sweeps
// and the builder contract (#807).
test('the smaller depot witnesses preserve portal reach', () => {
  const small = WITNESSES.filter(({ brief }) => brief.cells.length < 1000);
  assert.deepEqual(small.map(({ witness }) => witness), [2, 14]);
  assertWitnessReach(small, forward);
});

test('depot witnesses keep placements under reversed cell order', () => {
  for (const fixture of WITNESSES) {
    const { brief, witness } = fixture;
    const reversed = buildRegion({ ...brief, cells: [...brief.cells].reverse(), fillCells: [...brief.fillCells].reverse(),
      clearCells: [...brief.clearCells].reverse(), zones: brief.zones.map(zone => ({ ...zone, cells: [...zone.cells].reverse() })) });
    assert.deepEqual(reversed.elements, forward(fixture).elements, `seed ${witness}`);
  }
});
