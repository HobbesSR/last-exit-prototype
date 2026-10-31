import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [control, candidate, output] = process.argv.slice(2);
if (!output) throw Error('Usage: scale-check.mjs CONTROL CANDIDATE NEW_OUTPUT');
const hash = b => createHash('sha256').update(b).digest('hex');
const roots = { control: path.resolve(control), candidate: path.resolve(candidate) };
const pins = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, Object.fromEntries(['map/micro/strategies/content-access.ts', 'map/micro/geometry.ts', 'map/micro/strategies/depot.ts', 'tests/micro-depot.test.js'].map(f => [f, hash(fs.readFileSync(path.join(root, f)))]))]));
const report = { scope: 'Three locked pairs on the unchanged 200x150 depot witness; only local witness repair differs. Hard-capped attempts have no completion duration. Original >10 warehouses/>100 rows and 3s assertion remain.', node: process.version, pins, attempts: [] };
fs.writeFileSync(output, JSON.stringify(report), { flag: 'wx' });
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const lock = await acquireMachineLock('bench', { timeoutMs: 30 * 60_000, pollMs: 100 });
try {
  for (let repetition = 1; repetition <= 3; repetition++) for (const name of repetition % 2 ? ['control', 'candidate'] : ['candidate', 'control']) {
    // Keep the test in this child, so timeout cannot orphan a separate test worker.
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-name-pattern=a macro-sized depot with hundreds of portals builds quickly', 'tests/micro-depot.test.js'], {
      cwd: roots[name], env: { ...process.env, BUILD_BUDGETS: 'enforce' }, windowsHide: true,
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    const status = result.error?.code === 'ETIMEDOUT' ? 'time-cap' : result.status === 0 ? 'passed' : 'failed';
    report.attempts.push({ repetition, name, status, exitCode: result.status, error: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr });
    save(); console.log(JSON.stringify({ repetition, name, status }));
  }
  report.complete = true; save();
} finally { lock.release(); }
