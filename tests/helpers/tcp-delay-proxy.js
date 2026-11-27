import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

/**
 * A TCP delay proxy on loopback that applies a network profile (`rtt`, `jitter`) to every chunk in both
 * directions using the same exponential-jitter queueing model as `lossy-relay.js` (`ordered: true` per
 * direction, since TCP is ordered). No packets are dropped: TCP recovers loss via retransmission, so this
 * isolates round-trip latency and delay variation on a WebSocket stream.
 *
 * Runs on its own worker thread for sub-millisecond timing on Windows (where `setTimeout` is ~15 ms).
 */
const PROXY = `
const { parentPort, workerData } = require('node:worker_threads');
const net = require('node:net');
const { target, seed, rewriteHost } = workerData;
let profile = workerData.profile;
const now = () => performance.timeOrigin + performance.now();
let a = seed >>> 0;
const random = () => {
  a = (a + 0x6D2B79F5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const counts = { connections: 0, upChunks: 0, downChunks: 0, upBytes: 0, downBytes: 0 };
const delay = () => profile.rtt / 2 - profile.jitter * Math.log(1 - random());
const pending = [];
const sockets = new Set();
let spinning = false, closed = false;

const at = (due, fn) => {
  pending.push({ due, fn });
  if (!spinning) { spinning = true; setImmediate(spin); }
};

function spin() {
  const t = now(), ready = [];
  for (let i = 0; i < pending.length;) {
    if (pending[i].due <= t) ready.push(pending.splice(i, 1)[0]);
    else i++;
  }
  ready.sort((a, b) => a.due - b.due);
  for (const item of ready) item.fn();
  if (!pending.length || closed) { spinning = false; return; }
  setImmediate(spin);
}

const server = net.createServer(client => {
  if (closed) { client.destroy(); return; }
  counts.connections++;
  client.setNoDelay(true);
  const upstream = net.connect(target, '127.0.0.1');
  upstream.setNoDelay(true);
  sockets.add(client); sockets.add(upstream);
  const last = { up: 0, down: 0 };
  const due = dir => {
    const t = now() + delay();
    return (last[dir] = Math.max(last[dir], t));
  };
  let headerChecked = !rewriteHost, headerBuf = Buffer.alloc(0);

  client.on('data', chunk => {
    counts.upChunks++; counts.upBytes += chunk.length;
    if (!headerChecked) {
      headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk]) : chunk;
      const end = headerBuf.indexOf('\\r\\n\\r\\n');
      if (end === -1 && headerBuf.length < 16384) return;
      headerChecked = true;
      if (end !== -1) {
        const head = headerBuf.subarray(0, end + 4).toString('latin1').replace(/^Host: [^\\r\\n]+/im, 'Host: 127.0.0.1:' + target);
        chunk = Buffer.concat([Buffer.from(head, 'latin1'), headerBuf.subarray(end + 4)]);
      } else {
        chunk = headerBuf;
      }
      headerBuf = Buffer.alloc(0);
    }
    const out = chunk;
    at(due('up'), () => { if (!upstream.destroyed) upstream.write(out); });
  });
  upstream.on('data', chunk => {
    counts.downChunks++; counts.downBytes += chunk.length;
    at(due('down'), () => { if (!client.destroyed) client.write(chunk); });
  });
  client.on('end', () => at(due('up'), () => { if (!upstream.destroyed) upstream.end(); }));
  upstream.on('end', () => at(due('down'), () => { if (!client.destroyed) client.end(); }));
  const drop = () => {
    sockets.delete(client); sockets.delete(upstream);
    client.destroy(); upstream.destroy();
  };
  client.on('error', drop);
  upstream.on('error', drop);
  client.on('close', () => { sockets.delete(client); if (!upstream.destroyed) at(due('up'), () => upstream.destroy()); });
  upstream.on('close', () => { sockets.delete(upstream); if (!client.destroyed) at(due('down'), () => client.destroy()); });
});

server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', message => {
  if (message.profile) {
    profile = message.profile;
    parentPort.postMessage({ counts: { ...counts } });
    return;
  }
  if (message.counts) {
    parentPort.postMessage({ counts: { ...counts } });
    return;
  }
  closed = true;
  pending.length = 0;
  for (const s of sockets) s.destroy();
  sockets.clear();
  server.close(() => parentPort.postMessage({ counts: { ...counts } }));
});
`;

/**
 * Starts a TCP delay proxy to `127.0.0.1:${target}`. Resolves to `{ port, counts(), update(profile), stop() }`.
 */
export async function startTcpDelayProxy({ target, profile, seed, rewriteHost = false }) {
  const worker = new Worker(PROXY, { eval: true, workerData: { target, profile, seed, rewriteHost } });
  const { port } = (await once(worker, 'message'))[0];
  const ask = async message => {
    worker.postMessage(message);
    return (await once(worker, 'message'))[0].counts;
  };
  return {
    port,
    counts: () => ask({ counts: true }),
    update: next => ask({ profile: next }),
    async stop() {
      const counts = await ask({ stop: true });
      await worker.terminate();
      return counts;
    },
  };
}
