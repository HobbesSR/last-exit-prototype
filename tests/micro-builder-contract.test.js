import test from 'node:test';
import assert from 'node:assert/strict';
import { REGION_TYPES } from '../map/micro/region-types.ts';
import { compareCells } from '../map/kernel/cell.ts';
import { chainBrief, chainFixtures, reorderedBrief } from './helpers/chain-briefs.js';
import { assertStripsBuild, contractTests } from './helpers/builder-contract.js';

/** The builder contract (tests/helpers/builder-contract.js) for every type but the scatter types on a live cord. */
const CORD_TYPES = ['rubble', 'park', 'plant'];
contractTests(Object.keys(REGION_TYPES).filter(type => !CORD_TYPES.includes(type)));

test('a reordered brief lists the same cells in another order, so the order check is not vacuous', () => {
  const ordered = list => list.slice().sort(compareCells);
  for (const fixture of chainFixtures()) {
    const brief = chainBrief(fixture), other = reorderedBrief(brief, 1);
    for (const list of ['cells', 'fillCells', 'clearCells']) {
      assert.notDeepEqual(other[list], brief[list], `${fixture.name} ${list}`);
      assert.deepEqual(ordered(other[list]), ordered(brief[list]), `${fixture.name} ${list}`);
    }
    assert.deepEqual(other.portals, brief.portals, fixture.name);
  }
});

// #490: a pipe run's addressed area once reached a cell inside the access mask and outside
// the fill mask, where a cleared strip crosses the gap between two machines. Only the
// 224-map chain sweep found it, on one map. Strips across a plant's aisles at three offsets,
// with every slot taken and no shed, reproduce it: with the gap addressed again, 15 of these
// 120 builds throw (6 with the horizontal strips alone); with the fix, none do. Since types-62 plant
// places on a live cord and the 120 builds take about 22 s, so the fast tier runs three seeds and
// tests/slow/micro-plant-promise.test.js all forty.
test('plant: cleared strips crossing the aisles between its slots build (#490)', () => assertStripsBuild(3));
