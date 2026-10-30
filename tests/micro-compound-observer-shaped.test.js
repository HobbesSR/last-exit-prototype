import test from 'node:test';
import { SEEDS } from './helpers/compound-fixtures.js';
import { assertObservedRing } from './helpers/compound-sweeps.js';

test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour (ell)', () =>
  assertObservedRing(SEEDS.slice(0, 1), ['ell']));
