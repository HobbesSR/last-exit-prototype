import assert from 'node:assert/strict';

/**
 * Build-time budgets for the macro-sized builder tests (31). A duration depends on the machine and
 * on what else it is running, so the default run neither asserts nor prints one: the tests still
 * build the region and check what it holds. `BUILD_BUDGETS=report` prints each duration against
 * its limit and never fails; `BUILD_BUDGETS=enforce` fails past the limit. Enforce on a quiet
 * machine, one file at a time, to catch a builder turning quadratic.
 */
const MODES = ['report', 'enforce'];
const mode = process.env.BUILD_BUDGETS;
if (mode !== undefined && !MODES.includes(mode)) {
  throw new Error(`Invalid BUILD_BUDGETS value ${JSON.stringify(mode)}. Supported values: ${MODES.join(', ')}`);
}

export function assertWithinBudget(elapsed, limit, what = 'built') {
  if (mode === 'report') console.log(`${what} in ${Math.round(elapsed)} ms, budget ${limit} ms`);
  else if (mode === 'enforce') assert.ok(elapsed < limit, `${what} in ${Math.round(elapsed)} ms, budget ${limit} ms`);
}
