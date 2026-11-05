import test from 'node:test';
import { SEEDS } from '../helpers/compound-fixtures.js';
import { sweepCases, assertPortalPromise, assertRoofedRing, assertObservedRing } from '../helpers/compound-sweeps.js';

// The fast tier keeps one case per mask and per gate count (FAST_CASES); the slow tier runs every
// mask at every gate count over seeds 1–4, across this file and its tail (31, #543, #807).
const SWEPT = sweepCases(SEEDS.slice(0, 2));

test('a compound region keeps the portal promise over seeds, masks and gate counts', () => assertPortalPromise(SWEPT));
test('one compound has roofed rooms around a clear court and its gates', () => assertRoofedRing(SWEPT));
test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour', () => assertObservedRing(SWEPT));
