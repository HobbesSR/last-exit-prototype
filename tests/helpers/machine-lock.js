import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A machine-wide advisory lock, shared by every worktree run as the same OS user.
 *
 * Agents run gates concurrently from separate worktrees. Ports and scratch directories are
 * isolated per run, but CPU is not: two benchmarks overlapping would both report the other's
 * load as their own cost. Timing scripts take this lock so they run one at a time. It does not
 * serialize ordinary test runs; see docs/31.
 *
 * A lock whose owner has exited, or that is older than `maxAgeMs` (a guard against PID reuse),
 * is reclaimed. The file is removed on normal exit; a killed owner leaves a stale file that the
 * next caller reclaims.
 */
export async function acquireMachineLock(name, { timeoutMs = 30 * 60_000, pollMs = 2_000, maxAgeMs = 2 * 60 * 60_000, log = message => console.error(message) } = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Lock names are lowercase words joined by hyphens.');
  const file = path.join(tmpdir(), `last-exit-${name}.lock`);
  const mine = JSON.stringify({ pid: process.pid, cwd: process.cwd(), started: Date.now() });
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, mine); closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const held = read(file);
    if (held !== null && stale(held, maxAgeMs)) {
      // Re-read so a lock another waiter has just reclaimed and re-taken is not removed.
      if (read(file) === held) remove(file);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${name} lock held by ${describe(held)}. If no such run is active, delete ${file}.`);
    if (!reported) { log(`Waiting for the ${name} lock held by ${describe(held)} (${file}).`); reported = true; }
    await sleep(pollMs);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    if (read(file) === mine) remove(file);
  };
  process.on('exit', release);
  return { file, release };
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function remove(file) {
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function stale(text, maxAgeMs) {
  let owner;
  try { owner = JSON.parse(text); } catch { return true; }
  if (!Number.isSafeInteger(owner?.pid) || !Number.isFinite(owner?.started) || Date.now() - owner.started > maxAgeMs) return true;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

function describe(text) {
  try { const { pid, cwd } = JSON.parse(text); return `pid ${pid} in ${cwd}`; } catch { return 'an unreadable owner'; }
}
