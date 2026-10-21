import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const timing = fileURLToPath(new URL('./timing.mjs', import.meta.url));

for (const scenario of [
  { name: 'launch error', result: "{ status: null, error: new Error('spawn EPERM') }", reason: 'spawn EPERM' },
  { name: 'signal termination', result: "{ status: null, signal: 'SIGTERM' }", reason: 'terminated by SIGTERM' },
  { name: 'failed test', result: "{ status: 1, stdout: 'test failure detail\\n', stderr: 'child stderr\\n' }", reason: 'exit status 1' },
  { name: 'successful test', result: '{ status: 0, stdout: "", stderr: "" }' },
]) {
  test(`timing command reports ${scenario.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'last-exit-timing-'));
    try {
      // Inject the child outcome without relying on OS-specific ways to deny spawning
      // or kill a test process. The timing command itself runs as a real subprocess.
      const preload = join(dir, 'outcome.mjs');
      writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => (${scenario.result});
syncBuiltinESMExports();
`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, timing, '--strict', 'tests/example.test.js'], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.reason ? 1 : 0, result.stderr);
      if (scenario.reason) {
        assert.ok(result.stderr.includes(`FAILED tests/example.test.js: ${scenario.reason}`), result.stderr);
        assert.match(result.stdout, /\(FAILED\)/);
      } else {
        assert.doesNotMatch(result.stdout + result.stderr, /FAILED/);
      }
      if (scenario.name === 'failed test') {
        assert.match(result.stderr, /test failure detail/);
        assert.match(result.stderr, /child stderr/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Every child "passes" and takes 20 s of the clock the runner reads (two reads per file), so discovery and the tier
// each file is held to are observable without running a single real test.
function stubbedRun(dir, args) {
  const preload = join(dir, 'clock.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let now = 0;
performance.now = () => (now += 20_000);
childProcess.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
syncBuiltinESMExports();
`);
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, timing, ...args], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
}

test('timing inventory includes the root and macro tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-exit-timing-'));
  try {
    const result = stubbedRun(dir, []);
    assert.equal(result.status, 0, result.stderr);
    const timed = [...result.stderr.matchAll(/s {2}(\S+)$/gm)].map(m => m[1]);
    for (const file of ['tests/timing.test.js', 'tests/slow/room-sizes.test.js', 'map/macro/tests/wfc-large.test.ts', 'map/macro/tests/slow/chain-content.test.ts']) {
      assert.ok(timed.includes(file), `${file} is not timed by default`);
    }
    assert.ok(!timed.some(file => /\.browser\.|^map\/macro\/tests\/chain-(harness|stub)/.test(file)), timed.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timing holds macro slow files to the slow budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-exit-timing-'));
  try {
    const result = stubbedRun(dir, ['--strict', 'map/macro/tests/fast.test.ts', 'map/macro/tests/slow/slow.test.ts']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /OVER map\/macro\/tests\/fast\.test\.ts/);
    assert.match(result.stdout, / {5}map\/macro\/tests\/slow\/slow\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
