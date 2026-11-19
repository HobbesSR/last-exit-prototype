import { acquireMachineLock, LOCK_ENV } from './machine-lock.js';
import { buildCore } from '../../tools/build-core.mjs';

let lock;

/**
 * Node `--test-global-setup` hook: takes the shared machine lock for ordinary test runs,
 * or the exclusive lock when `BUILD_BUDGETS` is `enforce` or `report`.
 * Skips automatically when an outer wrapper (`brief.mjs`, `sets.mjs`, `timing.mjs`) already holds it.
 * Then builds the core once, before any test file: every stepping game loads it (docs/27).
 */
export async function globalSetup() {
  const budgetMode = process.env.BUILD_BUDGETS;
  const mode = budgetMode === 'enforce' || budgetMode === 'report' ? 'exclusive' : 'shared';
  lock = await acquireMachineLock('bench', { mode });
  if (!lock.inherited && !lock.skippedCi) process.env[LOCK_ENV] = mode;
  buildCore();
}

export async function globalTeardown() {
  lock?.release();
}
