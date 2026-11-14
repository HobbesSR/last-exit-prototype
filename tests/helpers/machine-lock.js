import net from 'node:net';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Machine-wide shared/exclusive locks using fixed loopback ports.
 *
 * The OS releases listening sockets the moment the holder exits or is killed, so there is no
 * lock file to go stale and no reclamation to race.
 * - `47913` (`bench` / `intent`) is the writer-intent and exclusive lock port.
 * - `47914..47915` are the two shared slots, capping concurrent test runs at two.
 *
 * Shared holders take any free shared slot while intent is unheld. An exclusive holder takes
 * intent first (blocking new shared holders) and then drains every shared slot before starting.
 * See `docs/31.2-benchmarks-and-timing-tools.md`.
 */
export const LOCK_PORTS = Object.freeze({ bench: 47913 });
export const SHARED_PORTS = Object.freeze([47914, 47915]);
export const DEFAULT_CONTENTION_THRESHOLD = 0.25;
export const LOCK_ENV = 'MACHINE_LOCK_HELD';

function machineCpuTotalsMs() {
  let total = 0, idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

/**
 * Sample machine-wide CPU busy share outside this process over an interval.
 * Returns a sampler function that reports `{ wallMs, selfCpuMs, otherBusyShare, contended, threshold }`.
 */
export function startContentionSample({ threshold = DEFAULT_CONTENTION_THRESHOLD } = {}) {
  const startWall = performance.now();
  const startCpu = process.cpuUsage();
  const startMachine = machineCpuTotalsMs();
  return () => {
    const wallMs = performance.now() - startWall;
    const cpu = process.cpuUsage(startCpu);
    const selfCpuMs = (cpu.user + cpu.system) / 1000;
    const endMachine = machineCpuTotalsMs();
    const totalDelta = endMachine.total - startMachine.total;
    const idleDelta = endMachine.idle - startMachine.idle;
    const busyDelta = Math.max(0, totalDelta - idleDelta);
    const otherBusyMs = Math.max(0, busyDelta - selfCpuMs);
    const otherBusyShare = totalDelta > 0 ? +(otherBusyMs / totalDelta).toFixed(4) : 0;
    return { wallMs, selfCpuMs, otherBusyShare, contended: otherBusyShare >= threshold, threshold };
  };
}

/**
 * Acquire a machine-wide lock (`mode: 'exclusive'` or `'shared'`).
 * @param {string} name
 * @param {object} [options]
 * @param {'exclusive'|'shared'} [options.mode='exclusive']
 * @param {number} [options.port]
 * @param {readonly number[]} [options.sharedPorts]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {boolean} [options.noWait]
 * @param {boolean} [options.force]
 * @param {number} [options.threshold]
 * @param {(message: string) => void} [options.log]
 */
export async function acquireMachineLock(name, {
  mode = 'exclusive',
  port = LOCK_PORTS[name],
  sharedPorts = SHARED_PORTS,
  timeoutMs = 30 * 60_000,
  pollMs = 2_000,
  noWait = process.argv.includes('--no-wait'),
  force = false,
  threshold = DEFAULT_CONTENTION_THRESHOLD,
  log = message => console.error(message),
} = {}) {
  if (mode !== 'exclusive' && mode !== 'shared') throw new Error(`Invalid machine lock mode ${JSON.stringify(mode)}.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`No lock port is assigned to ${name}.`);

  const held = process.env[LOCK_ENV];
  if (!force) {
    if (held === 'shared' && mode === 'exclusive') {
      throw new Error('Cannot upgrade an inherited shared machine lock to exclusive in a child process.');
    }
    if (held === mode || (held === 'exclusive' && mode === 'shared')) {
      return { port: null, ports: [], mode, inherited: true, release: () => {}, contention: startContentionSample({ threshold }) };
    }
  }

  // CI runs inside isolated containers; skip the host loopback lock unless forced (e.g. unit tests).
  const isDefaultLock = port === LOCK_PORTS[name] && sharedPorts === SHARED_PORTS;
  if (!force && isDefaultLock && (process.env.CI || process.env.FORGEJO_ACTIONS)) {
    return { port: null, ports: [], mode, skippedCi: true, release: () => {}, contention: startContentionSample({ threshold }) };
  }

  const owner = JSON.stringify({ pid: process.pid, cwd: process.cwd(), mode, name });
  const started = Date.now();
  const deadline = started + timeoutMs;
  const servers = [];
  let reported = false;

  const release = () => {
    while (servers.length) {
      try { servers.pop().close(); } catch {}
    }
  };

  try {
    if (mode === 'exclusive') {
      const intentServer = await waitForPort(port, owner, {
        label: `${name} exclusive intent`,
        deadline, pollMs, noWait,
        onWait: blocker => {
          if (!reported) {
            log(`Waiting for exclusive machine lock (${name}, pid ${process.pid} in ${process.cwd()}) behind ${blocker}.`);
            reported = true;
          }
        },
      });
      servers.push(intentServer);

      for (const slotPort of sharedPorts) {
        const slotServer = await waitForPort(slotPort, owner, {
          label: `${name} shared slot`,
          deadline, pollMs, noWait,
          onWait: blocker => {
            if (!reported) {
              log(`Waiting for exclusive machine lock (${name}, pid ${process.pid} in ${process.cwd()}) to drain ${blocker}.`);
              reported = true;
            }
          },
        });
        servers.push(slotServer);
      }
    } else {
      for (;;) {
        if (await isPortOccupied(port)) {
          const blocker = await holder(port);
          if (noWait) throw new Error(`--no-wait: shared machine lock (${name}) blocked by exclusive holder (${blocker}).`);
          if (!reported) {
            log(`Waiting for shared machine lock (${name}, pid ${process.pid} in ${process.cwd()}) behind ${blocker}.`);
            reported = true;
          }
        } else {
          let acquired = null;
          for (const slotPort of sharedPorts) {
            acquired = await listen(slotPort, owner);
            if (acquired) {
              servers.push(acquired);
              break;
            }
          }
          if (acquired) break;
          const blockers = await Promise.all(sharedPorts.map(p => holder(p)));
          if (noWait) throw new Error(`--no-wait: all ${sharedPorts.length} shared machine lock slots busy (${blockers.join('; ')}).`);
          if (!reported) {
            log(`Waiting for shared machine lock (${name}, pid ${process.pid} in ${process.cwd()}) behind ${blockers.join('; ')}.`);
            reported = true;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for shared machine lock (${name}, 127.0.0.1:${sharedPorts.join(',')}).`);
        }
        await sleep(pollMs);
      }
    }
  } catch (error) {
    release();
    throw error;
  }

  if (reported) {
    log(`Acquired ${mode} machine lock (${name}) after ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
  return { port: servers[0]?.address()?.port ?? port, ports: servers.map(s => s.address().port), mode, release, contention: startContentionSample({ threshold }) };
}

async function waitForPort(port, owner, { label, deadline, pollMs, noWait, onWait }) {
  for (;;) {
    const server = await listen(port, owner);
    if (server) return server;
    const blocker = await holder(port);
    if (noWait) throw new Error(`--no-wait: ${label} (127.0.0.1:${port}) held by ${blocker}.`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${label} lock (127.0.0.1:${port}) held by ${blocker}.`);
    onWait(blocker);
    await sleep(pollMs);
  }
}

function isPortOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = occupied => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(500, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
  });
}

/** A listening server that answers each connection with its owner, or null when the port is taken. */
function listen(port, owner) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      // A waiting benchmark abandons its owner probe after one second. The
      // holder may be CPU-bound until later, so that peer can already be gone.
      // A reset probe must not crash the benchmark holding the lock.
      socket.on('error', () => {});
      socket.unref();
      socket.end(owner);
    });
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
