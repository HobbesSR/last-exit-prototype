import test from 'node:test';
import { assertDepotAccess, SEEDS } from './helpers/depot-fixtures.js';

// The first seed on every mask at both room sizes; tests/slow/micro-depot-sweeps.test.js runs seeds
// 1 to 3 (#807).
test('every depot aisle is open to a contestant, indoors and out', () => assertDepotAccess(SEEDS.slice(0, 1)));
