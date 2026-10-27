import test from 'node:test';
import { SEEDS } from './helpers/block-masks.js';
import { assertBlockPromise } from './helpers/block-promise.js';

// Split from micro-block.test.js to keep each file inside the fast tier's budget (31). The fast tier runs
// the first seed on every mask; tests/slow/micro-block-promise.test.js runs them all.
test('a block keeps the portal promise on every mask', () => assertBlockPromise(SEEDS.slice(0, 1)));
