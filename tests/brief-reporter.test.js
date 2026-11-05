import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { briefNodeOptions, reporterUrl } from './brief.mjs';
import { drifted } from './brief-reporter.mjs';

const FILES = {
  'good.test.mjs': "import test from 'node:test';\nfor (let i = 0; i < 3; i++) test(`case ${i}`, () => {});\n",
  'mixed.test.mjs': [
    "import test from 'node:test'; import assert from 'node:assert/strict';",
    "test('passes', () => {});",
    "test('skipped', { skip: true }, () => {});",
    "test('parent', async t => { await t.test('good child', () => {}); await t.test('bad child', () => assert.equal(1 + 1, 3)); });",
    "test('known unfinished', { todo: 'pending' }, () => assert.equal(1, 2));",
  ].join('\n'),
  'late.test.mjs': [
    "import test from 'node:test';",
    "test('late error', () => { setTimeout(() => { throw new Error('important late error cause'); }, 10); });",
    "test('waits', async () => { await new Promise(resolve => setTimeout(resolve, 50)); });",
  ].join('\n'),
  'todo.test.mjs': "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('known unfinished', { todo: 'pending' }, () => assert.equal(1, 2));\n",
  'crash.test.mjs': 'throw new Error("import crash");\n',
};

// Runs `node --test` over throwaway files with the given NODE_OPTIONS (and no reporter flag of its
// own unless asked). Without NODE_TEST_CONTEXT the child is its own test runner, not this one's.
// The timing record lands in the throwaway directory; `record` is what it holds afterwards.
const runNodeTest = (files, { nodeOptions = '', reporterFlag = true } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brief-reporter-'));
  try {
    for (const name of files) writeFileSync(path.join(dir, name), FILES[name]);
    const { NODE_TEST_CONTEXT: _context, BRIEF_TIMES_DIR: _times, ...env } = process.env;
    const args = ['--test', ...(reporterFlag ? [`--test-reporter=${reporterUrl}`] : []), ...files];
    const result = spawnSync(process.execPath, args,
      { cwd: dir, encoding: 'utf8', env: { ...env, NODE_OPTIONS: nodeOptions, BRIEF_SCRIPT: 'probe', FORCE_COLOR: '0', NO_COLOR: '1' } });
    let record;
    try { record = JSON.parse(readFileSync(path.join(dir, 'test-results', 'test-times', 'probe.json'), 'utf8')); } catch { record = undefined; }
    return { ...result, record };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('brief reporter writes a line per file and the detail of each failure', () => {
  const result = runNodeTest(['good.test.mjs', 'mixed.test.mjs', 'late.test.mjs', 'crash.test.mjs']);
  const out = result.stdout;
  assert.equal(result.status, 1, result.stderr);
  assert.match(out, /^ok {3}good {2}3 ok {2}[\d.]+s$/m);
  assert.match(out, /^FAIL mixed {2}1 ok, 1 failed, 1 skipped, 1 todo {2}[\d.]+s$/m);
  assert.match(out, /^ {2}✖ mixed › bad child \(mixed\.test\.mjs:4\)\n.*\n.*\n.*2 !== 3$/m);
  assert.doesNotMatch(out, /known unfinished/, 'a failing TODO is not reported as a failure');
  assert.match(out, /^ {2}! late\n.*"late error".*important late error cause/m, 'a late error keeps its test and cause');
  assert.match(out, /^FAIL crash {2}0 ok, 1 failed {2}[\d.]+s$/m);
  assert.match(out, /Error: import crash/);
  assert.doesNotMatch(out, /node:internal|case 0|good child/, 'passing names and node frames stay out');
  assert.match(out, /^slowest: (\w+ [\d.]+s, ){3}\w+ [\d.]+s$/m, 'the slowest files, one line');
  assert.match(out, /^FAILED: 6 ok, 3 failed, 1 skipped, 1 todo, [\d.]+s\n$/m);
});

test('every run records each file and top-level test duration', () => {
  const result = runNodeTest(['good.test.mjs', 'late.test.mjs']);
  const [run] = result.record.runs;
  assert.equal(result.record.runs.length, 1);
  assert.equal(run.script, 'probe');
  assert.deepEqual(Object.keys(run.files).sort(), ['good.test.mjs', 'late.test.mjs']);
  assert.ok(Object.values(run.files).every(ms => Number.isInteger(ms) && ms >= 0));
  assert.deepEqual(Object.keys(run.tests['good.test.mjs']), ['case 0', 'case 1', 'case 2']);
  assert.ok(run.tests['late.test.mjs'].waits >= 40, 'a test that waits 50 ms records about that');
  assert.ok(Number.isInteger(run.wallMs) && run.cpus > 0);
});

test('a file is flagged slower only well above its median over enough earlier runs', () => {
  const runs = [1000, 1200, 1100].map(ms => ({ files: { 'a.test.js': ms, 'b.test.js': 500 } }));
  assert.deepEqual(drifted(runs, { 'a.test.js': 5000, 'b.test.js': 900, 'c.test.js': 9000 }),
    [{ file: 'a.test.js', ms: 5000, median: 1100, runs: 3 }], 'b is under 3 s more; c has no history');
  assert.deepEqual(drifted(runs.slice(0, 2), { 'a.test.js': 5000 }), [], 'two earlier runs are not enough');
  assert.deepEqual(drifted(runs, { 'a.test.js': 2100 }), [], 'under twice the median');
});

test('a failing TODO alone passes, as node does', () => {
  const result = runNodeTest(['todo.test.mjs']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok {3}todo {2}0 ok, 1 todo {2}[\d.]+s$/m);
  assert.match(result.stdout, /^passed: 0 ok, 0 failed, 0 skipped, 1 todo, [\d.]+s\n$/m);
});

test('the brief wrapper replaces a reporter already set in NODE_OPTIONS', () => {
  const inherited = `--max-old-space-size=4096 --test-reporter=dot --test-reporter-destination stdout --test-reporter "spec"`;
  const options = briefNodeOptions(inherited);
  assert.equal(options, `--max-old-space-size=4096 --test-reporter="${reporterUrl}"`);
  const result = runNodeTest(['good.test.mjs'], { nodeOptions: options, reporterFlag: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok {3}good {2}3 ok {2}[\d.]+s$/m);
});
