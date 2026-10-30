import test from 'node:test';
import { SEEDS } from './helpers/compound-fixtures.js';
import { assertObservedRing } from './helpers/compound-sweeps.js';

// Split the original shaped observer witness at its mask boundary (31): same
// seed, gate parameters and assertions, independently within the fast-file budget.
test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour (ring)', () =>
  assertObservedRing(SEEDS.slice(0, 1), ['ring']));
