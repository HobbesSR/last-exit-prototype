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
