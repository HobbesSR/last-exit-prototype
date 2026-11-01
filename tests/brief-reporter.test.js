import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A file URL, because a bare Windows path is not a module specifier.
const reporter = new URL('./brief-reporter.mjs', import.meta.url).href;

// Runs node --test with the brief reporter over throwaway files: one passing, one with a failing
// subtest and a skip, one that crashes on import.
test('brief reporter writes a line per file and the detail of each failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brief-reporter-'));
  try {
    writeFileSync(path.join(dir, 'good.test.mjs'), "import test from 'node:test';\nfor (let i = 0; i < 3; i++) test(`case ${i}`, () => {});\n");
    writeFileSync(path.join(dir, 'mixed.test.mjs'), [
      "import test from 'node:test'; import assert from 'node:assert/strict';",
      "test('passes', () => {});",
      "test('skipped', { skip: true }, () => {});",
      "test('parent', async t => { await t.test('good child', () => {}); await t.test('bad child', () => assert.equal(1 + 1, 3)); });",
    ].join('\n'));
    writeFileSync(path.join(dir, 'crash.test.mjs'), 'throw new Error("import crash");\n');
    // Without NODE_TEST_CONTEXT the child runs as its own test runner, not as this one's subprocess.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'good.test.mjs', 'mixed.test.mjs', 'crash.test.mjs'],
      { cwd: dir, encoding: 'utf8', env: { ...env, NODE_OPTIONS: '', FORCE_COLOR: '0', NO_COLOR: '1' } });
    const out = result.stdout;
    assert.equal(result.status, 1, result.stderr);
    assert.match(out, /^ok {3}good {2}3 ok$/m);
    assert.match(out, /^FAIL mixed {2}1 ok, 1 failed, 1 skipped$/m);
    assert.match(out, /^ {2}✖ mixed › bad child \(mixed\.test\.mjs:4\)\n.*\n.*\n.*2 !== 3$/m);
    assert.match(out, /^FAIL crash {2}0 ok, 1 failed$/m);
    assert.match(out, /Error: import crash/);
    assert.doesNotMatch(out, /node:internal|case 0|good child/, 'passing names and node frames stay out');
    assert.match(out, /^FAILED: 4 ok, 2 failed, 1 skipped, [\d.]+s\n$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
