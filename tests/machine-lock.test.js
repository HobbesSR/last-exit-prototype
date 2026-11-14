import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireMachineLock, LOCK_ENV, startContentionSample } from './helpers/machine-lock.js';

// Each test uses its own free ports so it never contends with a real benchmark or a parallel run.
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function freeLockPorts(slots = 2) {
  const ports = await Promise.all(Array.from({ length: 1 + slots }, () => freePort()));
  return { port: ports[0], sharedPorts: ports.slice(1) };
}
const quiet = { pollMs: 10, force: true, log: () => {} };
const helper = new URL('./helpers/machine-lock.js', import.meta.url).href;

/** A separate process that takes the lock, reports when it holds it, and runs `body` inside. */
function contender(port, body, { mode = 'exclusive', sharedPorts = [] } = {}) {
  const source = `import { acquireMachineLock } from ${JSON.stringify(helper)};
    const lock = await acquireMachineLock('test', { mode: ${JSON.stringify(mode)}, port: ${port}, sharedPorts: ${JSON.stringify(sharedPorts)}, pollMs: 5, force: true, log: () => {} });
    ${body}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  return child;
}

test('a second holder waits until the first releases', async () => {
  const ports = await freeLockPorts(0);
  const first = await acquireMachineLock('test', { ...quiet, ...ports });
  let acquired = false;
  const second = acquireMachineLock('test', { ...quiet, ...ports }).then(lock => { acquired = true; return lock; });
  await sleep(80);
  assert.equal(acquired, false);
  first.release();
  (await second).release();
});

test('concurrent processes hold the lock one at a time', async () => {
  const { port } = await freeLockPorts(0);
  // Timestamps are written as plain text: console.log colours numbers under FORCE_COLOR, which
  // agent shells set, and a coloured number parses as NaN.
  const children = Array.from({ length: 4 }, () => contender(port, `
    process.stdout.write('in ' + (performance.timeOrigin + performance.now()) + '\\n');
    await new Promise(resolve => setTimeout(resolve, 60));
    process.stdout.write('out ' + (performance.timeOrigin + performance.now()) + '\\n');
    lock.release();`));
  const outputs = await Promise.all(children.map(async child => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    return text;
  }));
  const spans = outputs.map(text => Object.fromEntries(text.trim().split('\n').map(line => line.split(' ')).map(([k, v]) => [k, Number(v)])));
  spans.sort((a, b) => a.in - b.in);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].in >= spans[i - 1].out, `holders ${i - 1} and ${i} overlapped`);
});

test('a killed holder releases the lock at once, and a live one is named on timeout', async () => {
  const { port } = await freeLockPorts(0);
  const child = contender(port, `console.log('held'); setInterval(() => {}, 1000);`);
  const [line] = await once(child.stdout, 'data');
  assert.match(line, /held/);
  await assert.rejects(acquireMachineLock('test', { ...quiet, port, sharedPorts: [], timeoutMs: 50 }), new RegExp(`held by pid ${child.pid} in `));
  child.kill('SIGKILL');
  await once(child, 'exit');
  (await acquireMachineLock('test', { ...quiet, port, sharedPorts: [], timeoutMs: 2_000 })).release();
});

test('a port taken by another program is reported as such', async () => {
  const { port } = await freeLockPorts(0);
  const foreign = net.createServer(socket => socket.destroy()).listen(port, '127.0.0.1');
  await once(foreign, 'listening');
  try {
    await assert.rejects(acquireMachineLock('test', { ...quiet, port, sharedPorts: [], timeoutMs: 30 }), /another program/);
  } finally { foreign.close(); }
});

test('an abandoned owner probe does not crash a busy holder', async () => {
  const { port } = await freeLockPorts(0);
  const child = contender(port, `
    console.log('held');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    await new Promise(resolve => setTimeout(resolve, 100));
    lock.release();`);
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const probe = net.connect({ port, host: '127.0.0.1' });
    probe.on('error', () => {});
    await once(probe, 'connect');
    probe.resetAndDestroy();
    const [code] = await exited;
    assert.equal(code, 0, 'a disconnected diagnostic client killed the lock owner');
  } finally { if (child.exitCode === null) child.kill(); }
});

test('shared mode caps concurrent holders at the slot count', async () => {
  const ports = await freeLockPorts(2);
  const first = await acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' });
  const second = await acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' });
  let thirdAcquired = false;
  const third = acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' }).then(l => { thirdAcquired = true; return l; });
  await sleep(60);
  assert.equal(thirdAcquired, false, 'third shared holder should wait for a free slot');
  first.release();
  (await third).release();
  second.release();
});

test('exclusive writer preference drains readers and blocks new shared holders', async () => {
  const ports = await freeLockPorts(2);
  const reader1 = await acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' });
  let writerAcquired = false;
  const writerLogs = [];
  const writer = acquireMachineLock('test', { ...quiet, ...ports, mode: 'exclusive', log: m => writerLogs.push(m) })
    .then(l => { writerAcquired = true; return l; });
  await sleep(50);
  assert.equal(writerAcquired, false, 'writer should wait while reader1 holds a slot');
  assert.ok(writerLogs.some(m => m.includes('Waiting for exclusive machine lock')), 'writer wait should be logged');

  // Even though slot 2 is free, a new reader must queue behind writer intent.
  let reader2Acquired = false;
  const reader2 = acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' }).then(l => { reader2Acquired = true; return l; });
  await sleep(50);
  assert.equal(reader2Acquired, false, 'new shared holder should block behind exclusive writer intent');

  reader1.release();
  const heldWriter = await writer;
  assert.equal(reader2Acquired, false, 'reader2 must still wait until writer releases');
  assert.ok(writerLogs.some(m => m.includes('Acquired exclusive machine lock')), 'writer acquire duration should be logged');

  heldWriter.release();
  (await reader2).release();
});

test('killed shared holder frees its slot immediately for a waiting writer', async () => {
  const ports = await freeLockPorts(2);
  const child = contender(ports.port, `console.log('shared-held'); setInterval(() => {}, 1000);`, { mode: 'shared', sharedPorts: ports.sharedPorts });
  const [line] = await once(child.stdout, 'data');
  assert.match(line, /shared-held/);

  await assert.rejects(acquireMachineLock('test', { ...quiet, ...ports, mode: 'exclusive', noWait: true }), /--no-wait/);
  child.kill('SIGKILL');
  await once(child, 'exit');
  (await acquireMachineLock('test', { ...quiet, ...ports, mode: 'exclusive', timeoutMs: 2_000 })).release();
});

test('noWait fails immediately when shared slots or intent are busy', async () => {
  const ports = await freeLockPorts(1);
  const holder = await acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared' });
  await assert.rejects(acquireMachineLock('test', { ...quiet, ...ports, mode: 'shared', noWait: true }), /--no-wait/);
  holder.release();
});

test('re-entrancy via MACHINE_LOCK_HELD avoids double-acquiring or deadlocking', async () => {
  const ports = await freeLockPorts(2);
  const prev = process.env[LOCK_ENV];
  try {
    process.env[LOCK_ENV] = 'shared';
    const nestedShared = await acquireMachineLock('test', { mode: 'shared', ...ports, pollMs: 10, log: () => {} });
    assert.equal(nestedShared.inherited, true);
    nestedShared.release();
    await assert.rejects(acquireMachineLock('bench', { mode: 'exclusive', ...ports, pollMs: 10, log: () => {} }), /Cannot upgrade/);
  } finally {
    if (prev === undefined) delete process.env[LOCK_ENV];
    else process.env[LOCK_ENV] = prev;
  }
});

test('unknown lock name throws when no port is given', async () => {
  await assert.rejects(acquireMachineLock('typo', { pollMs: 10, log: () => {} }), /No lock port is assigned to typo/);
});

test('contention sampler reports machine busy share outside this process', async () => {
  const sample = startContentionSample({ threshold: 0.5 });
  await sleep(30);
  const result = sample();
  assert.equal(typeof result.wallMs, 'number');
  assert.equal(typeof result.selfCpuMs, 'number');
  assert.ok(result.otherBusyShare >= 0 && result.otherBusyShare <= 1);
  assert.equal(typeof result.contended, 'boolean');
  assert.equal(result.threshold, 0.5);
});
