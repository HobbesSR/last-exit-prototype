import test from 'node:test';
import { assertSmallHouses } from '../helpers/hut-fixtures.js';

// The fast tier's tests/micro-hut.test.js runs the first seed of this sweep (#807).
test('small regions use a house with a reachable outside door', () => assertSmallHouses(Array.from({ length: 16 }, (_, i) => i + 1)));
