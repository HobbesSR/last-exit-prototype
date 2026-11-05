import test from 'node:test';
import { SEEDS, WITNESSES, assertDepotAccess, assertDepotPromise, assertWitnessReach } from '../helpers/depot-fixtures.js';

// The fast tier runs the first seed of each sweep and the reach of the two smaller production
// witnesses (tests/micro-depot.test.js, micro-depot-access, micro-depot-routing; #807).
test('a depot region keeps the portal promise over seeds, masks and parameters', () => assertDepotPromise(SEEDS));
test('every depot aisle is open to a contestant, indoors and out, over three seeds', () => assertDepotAccess(SEEDS.slice(0, 3)));
test('every production depot witness preserves portal reach', () => assertWitnessReach(WITNESSES));
