import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireMachineLock } from './helpers/machine-lock.js';

// Names are per process so this suite never contends with a real benchmark or a parallel run.
const unique = label => `test-${process.pid}-${label}`;
const quiet = { pollMs: 10, log: () => {} };

test('a second holder waits until the first releases', async () => {
  const first = await acquireMachineLock(unique('wait'), quiet);
  let acquired = false;
  const second = acquireMachineLock(unique('wait'), quiet).then(lock => { acquired = true; return lock; });
  await sleep(80);
  assert.equal(acquired, false);
  first.release();
  (await second).release();
  assert.equal(existsSync(first.file), false);
});

test('a lock left by an exited process is reclaimed', async () => {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  const name = unique('dead');
  const probe = await acquireMachineLock(name, quiet); probe.release();
  writeFileSync(probe.file, JSON.stringify({ pid, cwd: 'elsewhere', started: Date.now() }));
  const lock = await acquireMachineLock(name, { ...quiet, timeoutMs: 500 });
  assert.equal(JSON.parse(readFileSync(lock.file, 'utf8')).pid, process.pid);
  lock.release();
});

test('a live holder past the age limit is reclaimed, and a young one times out', async () => {
  const name = unique('age');
  const probe = await acquireMachineLock(name, quiet); probe.release();
  // The parent process is alive for the whole test, standing in for another agent's run.
  writeFileSync(probe.file, JSON.stringify({ pid: process.ppid, cwd: 'elsewhere', started: Date.now() }));
  await assert.rejects(acquireMachineLock(name, { ...quiet, timeoutMs: 60 }), /Timed out .* elsewhere\. .*delete/);
  writeFileSync(probe.file, JSON.stringify({ pid: process.ppid, cwd: 'elsewhere', started: Date.now() - 10_000 }));
  const lock = await acquireMachineLock(name, { ...quiet, maxAgeMs: 5_000, timeoutMs: 500 });
  lock.release();
});

test('release never removes a lock that another owner now holds', async () => {
  const lock = await acquireMachineLock(unique('owner'), quiet);
  const other = JSON.stringify({ pid: process.ppid, cwd: 'elsewhere', started: Date.now() });
  writeFileSync(lock.file, other);
  lock.release();
  assert.equal(readFileSync(lock.file, 'utf8'), other);
  rmSync(lock.file);
});
