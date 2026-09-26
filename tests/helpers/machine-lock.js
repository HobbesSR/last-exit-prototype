import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Machine-wide locks, one fixed loopback port per name. The fixed port is the point: only one
 * process can listen on it, and the OS releases it the moment the holder exits or is killed, so
 * there is no lock file to go stale and no reclamation to race.
 *
 * Agents run gates concurrently from separate worktrees. Ports and scratch directories are
 * isolated per run, but CPU is not: two overlapping benchmarks would each report the other's
 * load as their own cost. Timing scripts take the `bench` lock so they run one at a time. It
 * does not serialize ordinary test runs; see docs/31.
 */
export const LOCK_PORTS = Object.freeze({ bench: 47913 });

export async function acquireMachineLock(name, { port = LOCK_PORTS[name], timeoutMs = 30 * 60_000, pollMs = 2_000, log = message => console.error(message) } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`No lock port is assigned to ${name}.`);
  const owner = JSON.stringify({ pid: process.pid, cwd: process.cwd() });
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  for (;;) {
    const server = await listen(port, owner);
    if (server) {
      let released = false;
      const release = () => { if (!released) { released = true; server.close(); } };
      return { port, release };
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${name} lock (127.0.0.1:${port}) held by ${await holder(port)}.`);
    if (!reported) { log(`Waiting for the ${name} lock (127.0.0.1:${port}) held by ${await holder(port)}.`); reported = true; }
    await sleep(pollMs);
  }
}

/** A listening server that answers each connection with its owner, or null when the port is taken. */
function listen(port, owner) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => { socket.unref(); socket.end(owner); });
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(null) : reject(error));
    // Unreferenced: holding the lock never keeps a finished script alive.
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.unref(); resolve(server); });
  });
}

/**
 * Ask the holder who it is. A benchmark's busy event loop may not answer in time, so silence is
 * ambiguous: it is either a busy holder or another program that happens to use the port.
 */
function holder(port) {
  return new Promise(resolve => {
    let text = '';
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = () => {
      socket.destroy();
      try { const { pid, cwd } = JSON.parse(text); resolve(`pid ${pid} in ${cwd}`); } catch { resolve('a process that did not identify itself (a busy benchmark, or another program using this port)'); }
    };
    socket.setTimeout(1_000, done);
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', done);
    socket.on('error', done);
  });
}
