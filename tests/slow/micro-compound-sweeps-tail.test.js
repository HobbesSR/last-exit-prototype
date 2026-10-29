import test from 'node:test';
import { SEEDS } from '../helpers/compound-fixtures.js';
import { assertPortalPromise, assertRoofedRing, assertObservedRing } from '../helpers/compound-sweeps.js';

// Continue the same four-seed slow sweep with seeds 3–4 (31, #543).
const SWEPT = SEEDS.slice(2, 4);

test('a compound region keeps the portal promise over seeds, masks and gate counts', () => assertPortalPromise(SWEPT));
test('one compound has roofed rooms around a clear court and its gates', () => assertRoofedRing(SWEPT));
test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour', () => assertObservedRing(SWEPT));
