import test from 'node:test';
import { SEEDS } from '../helpers/plant-fixtures.js';
import { assertPlantPromise, assertPlantSpacing } from '../helpers/plant-promise.js';
import { assertStripsBuild } from '../helpers/builder-contract.js';

// The fast tier's tests/micro-plant.test.js runs the first two seeds of each sweep (31, #543, #759).
test('a plant region keeps the portal promise over seeds, masks and parameters', () => assertPlantPromise(SEEDS));
test('machines and the shed keep an aisle from each other and respect portal margins, and pipes from all but what they join', () =>
  assertPlantSpacing(SEEDS));
// #490's strips at all forty seeds; the fast tier's builder contract runs three.
test('plant: cleared strips crossing the aisles between its slots build (#490)', () => assertStripsBuild(40));
