import { acquireMachineLock, LOCK_ENV } from './machine-lock.js';

let lock;

/**
 * Node `--test-global-setup` hook: takes the shared machine lock for ordinary test runs,
 * or the exclusive lock when `BUILD_BUDGETS` is `enforce` or `report`.
 * Skips automatically when an outer wrapper (`brief.mjs`, `sets.mjs`, `timing.mjs`) already holds it.
 */
export async function globalSetup() {
  const budgetMode = process.env.BUILD_BUDGETS;
  const mode = budgetMode === 'enforce' || budgetMode === 'report' ? 'exclusive' : 'shared';
  lock = await acquireMachineLock(mode === 'exclusive' ? 'bench' : 'test', { mode });
  if (!lock.inherited && !lock.skippedCi) process.env[LOCK_ENV] = mode;
}

export async function globalTeardown() {
  lock?.release();
}
