import test from 'node:test';
import { SEEDS } from '../helpers/block-masks.js';
import { assertBlockPromise } from '../helpers/block-promise.js';

// The fast tier's tests/micro-block-promise.test.js runs the first seed on every mask (31, #543).
test('a block keeps the portal promise over seeds and masks', () => assertBlockPromise(SEEDS));
