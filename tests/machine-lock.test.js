import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireMachineLock } from './helpers/machine-lock.js';

// Each test uses its own free port so it never contends with a real benchmark or a parallel run.
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
const quiet = { pollMs: 10, log: () => {} };
const helper = new URL('./helpers/machine-lock.js', import.meta.url).href;

/** A separate process that takes the lock, reports when it holds it, and runs `body` inside. */
function contender(port, body) {
  const source = `import { acquireMachineLock } from ${JSON.stringify(helper)};
    const lock = await acquireMachineLock('test', { port: ${port}, pollMs: 5, log: () => {} });
    ${body}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  return child;
}

test('a second holder waits until the first releases', async () => {
  const port = await freePort();
  const first = await acquireMachineLock('test', { ...quiet, port });
  let acquired = false;
  const second = acquireMachineLock('test', { ...quiet, port }).then(lock => { acquired = true; return lock; });
  await sleep(80);
  assert.equal(acquired, false);
  first.release();
  (await second).release();
});

test('concurrent processes hold the lock one at a time', async () => {
  const port = await freePort();
  const children = Array.from({ length: 4 }, () => contender(port, `
    console.log('in', performance.timeOrigin + performance.now());
    await new Promise(resolve => setTimeout(resolve, 60));
    console.log('out', performance.timeOrigin + performance.now());
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
  const port = await freePort();
  const child = contender(port, `console.log('held'); setInterval(() => {}, 1000);`);
  const [line] = await once(child.stdout, 'data');
  assert.match(line, /held/);
  await assert.rejects(acquireMachineLock('test', { ...quiet, port, timeoutMs: 50 }), new RegExp(`held by pid ${child.pid} in `));
  child.kill('SIGKILL');
  await once(child, 'exit');
  (await acquireMachineLock('test', { ...quiet, port, timeoutMs: 2_000 })).release();
});

test('a port taken by another program is reported as such', async () => {
  const port = await freePort();
  const foreign = net.createServer(socket => socket.destroy()).listen(port, '127.0.0.1');
  await once(foreign, 'listening');
  try {
    await assert.rejects(acquireMachineLock('test', { ...quiet, port, timeoutMs: 30 }), /another program/);
  } finally { foreign.close(); }
});
