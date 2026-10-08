import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// Times each unit test file alone, one at a time, and flags the ones over budget so a slow test is
// noticed when it is added rather than when someone waits on it. Files run serially on purpose:
// `npm test` runs them in parallel, which hides each file's own cost behind the longest one.
//   npm run test:times                 report every file, slowest first
//   npm run test:times -- --strict     exit 1 when a file is over budget
//   npm run test:times -- tests/x.test.js ...   time only these files
// A fast-tier file over FAST_BUDGET_S should be optimized (share a generated map between tests, build
// fewer rooms) or split into files that run in parallel. A slow-tier file over SLOW_BUDGET_S should
// gate its largest cases behind an environment variable, as tests/slow/room-sizes.test.js does (31).
const FAST_BUDGET_S = 15, SLOW_BUDGET_S = 60;

const args = process.argv.slice(2), strict = args.includes('--strict');
const named = args.filter(arg => !arg.startsWith('--'));
const files = named.length ? named : [
  ...readdirSync('tests').filter(f => f.endsWith('.test.js')).map(f => `tests/${f}`),
  ...readdirSync('tests/slow').filter(f => f.endsWith('.test.js')).map(f => `tests/slow/${f}`),
];

const rows = [];
for (const file of files) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
  const seconds = (performance.now() - start) / 1000;
  const budget = file.includes('/slow/') ? SLOW_BUDGET_S : FAST_BUDGET_S;
  const tests = [...(result.stdout ?? '').matchAll(/^\s*✔ (.+) \(([\d.]+)ms\)$/gm)].map(m => ({ name: m[1], seconds: +m[2] / 1000 }));
  const failed = result.status !== 0 || Boolean(result.error) || Boolean(result.signal);
  rows.push({ file, seconds, budget, failed, tests });
  process.stderr.write(`${seconds.toFixed(1).padStart(7)}s  ${file}\n`);
  if (failed) {
    const reason = result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : `exit status ${result.status}`);
    process.stderr.write(`FAILED ${file}: ${reason}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

rows.sort((a, b) => b.seconds - a.seconds);
console.log('\nslowest first (budget: fast tier %ds, slow tier %ds per file)', FAST_BUDGET_S, SLOW_BUDGET_S);
for (const row of rows.slice(0, 15)) {
  const over = row.seconds > row.budget;
  console.log(`${row.seconds.toFixed(1).padStart(7)}s ${over ? 'OVER ' : '     '}${row.file}${row.failed ? '  (FAILED)' : ''}`);
  if (over) for (const t of row.tests.sort((a, b) => b.seconds - a.seconds).slice(0, 3)) console.log(`           ${t.seconds.toFixed(1).padStart(6)}s  ${t.name}`);
}
console.log(`total ${rows.reduce((sum, row) => sum + row.seconds, 0).toFixed(0)}s serial across ${rows.length} files`);
const over = rows.filter(row => row.seconds > row.budget), failed = rows.filter(row => row.failed);
if (failed.length) process.exitCode = 1;
else if (strict && over.length) process.exitCode = 1;
