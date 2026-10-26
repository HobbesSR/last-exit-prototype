import assert from 'node:assert/strict';

/**
 * Asserts `elapsed` ms is under `limit`, except in CI (31): the limits are tuned on the
 * desktop, and a slower runner would fail them on speed rather than on the change.
 * They are there to catch a builder turning quadratic during local iteration.
 */
export function assertWithinBudget(elapsed, limit, what = 'built') {
  if (process.env.CI) return;
  assert.ok(elapsed < limit, `${what} in ${Math.round(elapsed)} ms, budget ${limit} ms`);
}
