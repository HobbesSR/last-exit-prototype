import test from 'node:test';
import { SLOW_CASES, assertPortalPromise, assertRoofedRing, assertObservedRing, assertRoomsAndCourtReached } from '../helpers/compound-sweeps.js';

// The fast tier keeps one case per mask and per gate count at seed 1 (FAST_CASES); the slow tier
// runs every mask at every gate count once more, seeds 2–4 rotating (SLOW_CASES, 31, #822). Each
// case is built once, with the observer on, and every check reads that build.
test('a compound region keeps the portal promise over seeds, masks and gate counts', () => assertPortalPromise(SLOW_CASES));
test('one compound has roofed rooms around a clear court and its gates', () => assertRoofedRing(SLOW_CASES));
test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour', () =>
  assertObservedRing(SLOW_CASES, { unobserved: false }));
// One gate is the longest way in, so each mask's one-gate case carries the bodies' routes.
test('every room and the court are open through compound gates across masks', () =>
  assertRoomsAndCourtReached(SLOW_CASES.filter(({ parameters }) => parameters?.gates === 1)));
