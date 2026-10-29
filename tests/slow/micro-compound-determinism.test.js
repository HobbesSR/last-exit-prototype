import test from 'node:test';
import { SEEDS } from '../helpers/compound-fixtures.js';
import { assertCompoundDeterminism } from '../helpers/compound-sweeps.js';

test('compounds are deterministic and independent of brief cell order across all seeds', () =>
  assertCompoundDeterminism(SEEDS));
