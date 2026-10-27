import test from 'node:test';
import { SEEDS } from '../helpers/plant-fixtures.js';
import { assertPlantPromise } from '../helpers/plant-promise.js';

// The fast tier's tests/micro-plant.test.js runs the first two seeds (31, #543).
test('a plant region keeps the portal promise over seeds, masks and parameters', () => assertPlantPromise(SEEDS));
