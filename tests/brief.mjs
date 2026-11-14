import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireMachineLock, LOCK_ENV } from './helpers/machine-lock.js';

// Runs an npm test script with the thin reporter (tests/brief-reporter.mjs), the same in any shell:
//   npm run brief -- test          npm run brief -- test:slow          npm run brief -- test:physics
// NODE_OPTIONS carries the reporter because node ignores a --test-reporter placed after the file
// globs that `npm test -- <flag>` appends. An absolute URL keeps it valid in scripts that change
// directory (test:mapgen). Exits with the script's status.
export const reporterUrl = new URL('./brief-reporter.mjs', import.meta.url).href;

// An inherited reporter or destination would leave node with more reporters than destinations,
// which it rejects before running anything, so those options are replaced rather than added to.
const REPORTER_OPTION = /(^|\s)--test-reporter(?:-destination)?(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g;
export const withoutReporterOptions = (nodeOptions = '') => nodeOptions.replace(REPORTER_OPTION, ' ').trim();
export const briefNodeOptions = (inherited = '') =>
  `${withoutReporterOptions(inherited)} --test-reporter="${reporterUrl}"`.trim();
// `--` hands the rest to the script: npm 12 would otherwise read a flag such as `--slow` as its own
// option and refuse it, which --silent hides.
export const npmArgs = (script, extra = []) => ['run', '--silent', script, ...(extra.length && extra[0] !== '--' ? ['--', ...extra] : extra)];

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const script = process.argv[2];
  if (!script) {
    console.error('usage: npm run brief -- <npm test script, e.g. test or test:slow>');
    process.exit(2);
  }
  // BRIEF_SCRIPT names the reporter's timing record, so each script keeps its own history.
  const budgetMode = process.env.BUILD_BUDGETS;
  const lockMode = script === 'test:times' ? null : (budgetMode === 'enforce' || budgetMode === 'report' ? 'exclusive' : 'shared');
  const lock = lockMode ? await acquireMachineLock(lockMode === 'exclusive' ? 'bench' : 'test', { mode: lockMode }) : null;
  try {
    const env = {
      ...process.env,
      NODE_OPTIONS: briefNodeOptions(process.env.NODE_OPTIONS),
      BRIEF_SCRIPT: script,
      ...(lock && !lock.inherited && !lock.skippedCi ? { [LOCK_ENV]: lockMode } : {}),
    };
    const args = npmArgs(script, process.argv.slice(3));
    const npm = process.env.npm_execpath;
    const result = npm
      ? spawnSync(process.execPath, [npm, ...args], { stdio: 'inherit', env })
      : spawnSync('npm', args, { stdio: 'inherit', env, shell: true });
    process.exitCode = result.status ?? 1;
  } finally {
    lock?.release();
  }
}
