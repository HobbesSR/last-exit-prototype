// #1095 (42.56): a real WebTransport session from a Node server to Chrome, through a lossy UDP relay, against a
// reliable WebTransport stream and a WebSocket. It measures the transport, not our codec. Every 50 ms the server
// sends one frame of `--bytes` (a 42.55-sized steady D message by default) on each channel:
// - a datagram;
// - a length-prefixed message on one server-opened reliable unidirectional stream (S's reliable half in 24.2,
//   and the stand-in for today's WebSocket under loss);
// - a WebSocket message, over loopback. TCP loss cannot be injected on loopback, so this row is the lossless
//   baseline only.
// The relay applies 42.48's network profiles (and 42.50's bursty one) to every UDP packet in both directions:
// half the rtt plus exponential jitter, independent loss, bursty outages per 50 ms slot. QUIC's own handshake,
// acknowledgements and retransmissions go through it. The relay runs on its own thread and senders tick on absolute
// deadlines, so neither Windows' timer granularity nor each other's timing skews the measurement (review 906).
// `--profiles=poor-lossless` adds a control: poor's delays without its loss. The browser samples, every 10 ms, the age of the newest
// frame it holds on each channel (staleness), and echoes 100 ms pings for round trip.
//
// The WebTransport server is @fails-components/webtransport (BSD-3-Clause), which is not a project dependency
// while #1095's stack is undecided. Install it outside the repository and pass that directory:
//   npm install --prefix DIR @fails-components/webtransport@1.6.12 @fails-components/webtransport-transport-http3-quiche@1.6.12
//   (npm 12 blocks its install script; fetch the prebuilt binary with
//    `node DIR/node_modules/prebuild-install/bin.js -r napi` run inside the quiche package directory)
// Needs `openssl` on PATH for the short-lived certificate (ECDSA P-256, under 14 days: serverCertificateHashes).
// Usage: node tools/perf/transport-1095-probe.mjs --module-dir=DIR [--profiles=lan,typical,poor] [--seconds=20]
//        [--bytes=350] [--runs=1] [--seed=1095] [--out=FILE]
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';
import { chromium } from '@playwright/test';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { chooseProfiles, NETWORK_PROFILES } from '../../tests/helpers/network-profiles.js';
import { startLossyRelay } from '../../tests/helpers/lossy-relay.js';

const args = cliArgs();
const moduleDir = args.get('module-dir');
if (!moduleDir) throw new Error('--module-dir=DIR: where @fails-components/webtransport is installed (see the header).');
const seconds = Number(args.get('seconds') ?? 20), bytes = Number(args.get('bytes') ?? 350), runs = Number(args.get('runs') ?? 1);
const seed = Number(args.get('seed') ?? 1095), TICK = 50;
// 42.48's profiles, 42.50's bursty one and 42.56's control (tests/helpers/network-profiles.js).
const chosen = chooseProfiles(args.get('profiles'));

// The package exports only an `import` condition, which createRequire cannot resolve, so follow its exports map.
const packageDir = join(moduleDir, 'node_modules', '@fails-components', 'webtransport');
const entry = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).exports['.'].node.import;
const { Http3Server } = await import(pathToFileURL(join(packageDir, entry)).href);
const now = () => performance.timeOrigin + performance.now();

/** A short-lived ECDSA P-256 certificate and the SHA-256 of its DER, for serverCertificateHashes. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-1095-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-days', '10', '-subj', '/CN=127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8'), key = readFileSync(join(dir, 'key.pem'), 'utf8');
    const der = Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    return { cert, key, hash: [...createHash('sha256').update(der).digest()] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A frame: u32 sequence, f64 send time, random filler to `bytes`. */
function frame(seq) {
  const b = randomBytes(bytes);
  b.writeUInt32LE(seq, 0); b.writeDoubleLE(now(), 4);
  return b;
}

const PAGE = `<!doctype html><meta charset=utf-8><script>
const now = () => performance.timeOrigin + performance.now()
window.probe = async (hash, wtUrl, wsUrl, duration, oversize) => {
  const kinds = ['dgram', 'stream', 'ws'], seen = {}, latency = {}, newest = {}, staleness = {}, rtt = { dgram: [], ws: [] }
  for (const k of kinds) { seen[k] = new Set(); latency[k] = []; newest[k] = { seq: -1, sent: 0 }; staleness[k] = [] }
  const got = (k, buf) => { const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), seq = v.getUint32(0, true), sent = v.getFloat64(4, true)
    seen[k].add(seq); latency[k].push(now() - sent); if (seq > newest[k].seq) newest[k] = { seq, sent } }
  const isPing = b => b.byteLength === 9
  let oversizeReceived = false
  const t0 = now()
  const wt = new WebTransport(wtUrl, { serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(hash) }] })
  await wt.ready
  const connectMs = now() - t0
  const ws = new WebSocket(wsUrl); ws.binaryType = 'arraybuffer'
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = e => { const b = new Uint8Array(e.data); isPing(b) ? rtt.ws.push(now() - new DataView(e.data).getFloat64(1, true)) : got('ws', b) }
  ;(async () => { const r = wt.datagrams.readable.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return
    if (value.byteLength === 1300) { oversizeReceived = true; continue }
    isPing(value) ? rtt.dgram.push(now() - new DataView(value.buffer, value.byteOffset).getFloat64(1, true)) : got('dgram', value) } })().catch(() => {})
  ;(async () => { const { value: s } = await wt.incomingUnidirectionalStreams.getReader().read(); const r = s.getReader()
    let pend = new Uint8Array(0)
    for (;;) { const { value, done } = await r.read(); if (done) return
      const n = new Uint8Array(pend.length + value.length); n.set(pend); n.set(value, pend.length); pend = n
      while (pend.length >= 4) { const len = new DataView(pend.buffer, pend.byteOffset).getUint32(0, true); if (pend.length < 4 + len) break
        got('stream', pend.subarray(4, 4 + len)); pend = pend.slice(4 + len) } } })().catch(() => {})
  const dw = wt.datagrams.createWritable ? wt.datagrams.createWritable().getWriter() : wt.datagrams.writable.getWriter()
  let oversizeError = null
  if (oversize) await dw.write(new Uint8Array(oversize)).catch(e => { oversizeError = String(e) })
  const ping = () => { const b = new Uint8Array(9); new DataView(b.buffer).setFloat64(1, now(), true); dw.write(b).catch(() => {}); ws.send(b) }
  const pings = setInterval(ping, 100)
  const sampler = setInterval(() => { const t = now(); for (const k of kinds) if (newest[k].sent) staleness[k].push(t - newest[k].sent) }, 10)
  await new Promise(r => setTimeout(r, duration))
  clearInterval(pings); clearInterval(sampler); wt.close(); ws.close()
  const out = { connectMs, maxDatagramSize: wt.datagrams.maxDatagramSize, oversizeError, oversizeReceived, rtt }
  for (const k of kinds) out[k] = { seqs: [...seen[k]], latency: latency[k], staleness: staleness[k] }
  return out
}
</script>`;

/** A UDP port free a moment ago: the server reports the port it was given, not the one it bound. */
async function freeUdpPort() {
  const probe = dgram.createSocket('udp4');
  await new Promise(r => probe.bind(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  return port;
}

/**
 * Calls `fn` every TICK ms on absolute deadlines. Windows' setInterval rounds to its timer granularity, which sent
 * 171 frames in 10 s instead of 200; a timer brings each wait within 16 ms and setImmediate spins to the deadline.
 * Returns a stop function.
 */
function ticker(fn) {
  let due = now() + TICK, stopped = false, handle = null;
  const wait = () => {
    if (stopped) return;
    const left = due - now();
    if (left > 16) { handle = setTimeout(wait, left - 16); return; }
    if (left > 0) { handle = setImmediate(wait); return; }
    due += TICK;
    fn();
    wait();
  };
  handle = setTimeout(wait, TICK - 16);
  return () => { stopped = true; clearTimeout(handle); clearImmediate(handle); };
}

const stats = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const r = n => Math.round(n * 10) / 10;
  return { n: list.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(sorted.at(-1)) };
};

async function run(profile, runIndex, browser) {
  const { cert, key, hash } = certificate();
  const wtPort = await freeUdpPort();
  const server = new Http3Server({ port: wtPort, host: '127.0.0.1', secret: randomBytes(16).toString('hex'), cert, privKey: key });
  server.startServer(); await server.ready;
  const serverSide = { sessions: 0, datagramWriteErrors: 0, oversizeArrived: false, framesSent: 0,
    maxDatagramSize: null, oversizeWriteError: null };
  const timers = new Set();
  (async () => {
    const reader = server.sessionStream('/probe').getReader();
    for (;;) {
      const { value: session, done } = await reader.read(); if (done) return;
      serverSide.sessions++;
      await session.ready;
      const dw = (session.datagrams.createWritable?.() ?? session.datagrams.writable).getWriter();
      const sw = (await session.createUnidirectionalStream()).getWriter();
      serverSide.maxDatagramSize = session.datagrams.maxDatagramSize ?? null;
      // Server to client: does an oversized datagram fail, or vanish as Chrome's does?
      await dw.write(new Uint8Array(1300)).catch(e => { serverSide.oversizeWriteError = String(e); });
      (async () => { const r = session.datagrams.readable.getReader(); for (;;) { const { value, done: end } = await r.read(); if (end) return
        if (value.byteLength === 9) dw.write(value).catch(() => serverSide.datagramWriteErrors++); else serverSide.oversizeArrived = true; } })().catch(() => {});
      let seq = 0;
      const stop = ticker(() => {
        serverSide.framesSent = seq + 1;
        const f = frame(seq++), prefix = Buffer.alloc(4); prefix.writeUInt32LE(f.length);
        dw.write(new Uint8Array(f)).catch(() => serverSide.datagramWriteErrors++);
        sw.write(new Uint8Array(Buffer.concat([prefix, f]))).catch(() => {});
      });
      timers.add(stop);
      session.closed.finally(stop).catch(() => {});
    }
  })().catch(() => {});

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  wss.on('connection', ws => {
    let seq = 0;
    const stop = ticker(() => ws.send(frame(seq++)));
    timers.add(stop);
    ws.on('message', m => ws.send(m));
    ws.on('close', stop);
  });

  const relay = await startLossyRelay({ target: wtPort, profile, seed: seed ^ (runIndex * 0x9E3779B1) ^ NETWORK_PROFILES.indexOf(profile) * 0x85EBCA6B, tick: TICK });
  const relayPort = relay.port;

  const http = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const tab = await browser.newPage();
  let out;
  try {
    await tab.goto(`http://127.0.0.1:${http.address().port}/`);
    const res = await tab.evaluate(([h, a, b, d, o]) => window.probe(h, a, b, d, o),
      [hash, `https://127.0.0.1:${relayPort}/probe`, `ws://127.0.0.1:${wss.address().port}/`, seconds * 1000, 1300]);
    out = { profile: profile.name, run: runIndex, bytes, seconds, connectMs: Math.round(res.connectMs),
      maxDatagramSize: { client: res.maxDatagramSize, server: serverSide.maxDatagramSize },
      oversize: { bytes: 1300, clientToServer: { writeError: res.oversizeError, arrived: serverSide.oversizeArrived },
        serverToClient: { writeError: serverSide.oversizeWriteError, arrived: res.oversizeReceived } },
      relay: null, server: { sessions: serverSide.sessions, datagramWriteErrors: serverSide.datagramWriteErrors, framesSent: serverSide.framesSent },
      rtt: { datagram: stats(res.rtt.dgram), webSocket: stats(res.rtt.ws) } };
    for (const [k, name] of [['dgram', 'datagram'], ['stream', 'reliableStream'], ['ws', 'webSocket']]) {
      const c = res[k], last = Math.max(...c.seqs);
      out[name] = { delivered: Math.round(1000 * c.seqs.length / (last + 1)) / 10, latency: stats(c.latency), staleness: stats(c.staleness) };
    }
  } finally {
    await tab.close();
    for (const stop of timers) stop();
    const relayCounts = await relay.stop();
    if (out) out.relay = relayCounts;
    server.stopServer(); wss.close(); http.close();
  }
  return out;
}

const lock = await acquireMachineLock('bench');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], browserVersion = browser.version();
try {
  for (const profile of chosen) for (let i = 0; i < runs; i++) {
    const r = await run(profile, i, browser);
    results.push(r);
    const s = k => `${r[k].delivered}% p95 lat ${r[k].latency?.p95} stale ${r[k].staleness?.p50}/${r[k].staleness?.p95}/${r[k].staleness?.p99}`;
    console.log(`${profile.name}#${i}: connect ${r.connectMs} ms | dgram ${s('datagram')} | stream ${s('reliableStream')} | ws ${s('webSocket')}`);
  }
} finally {
  await browser.close();
  await lock.release();
}
const record = { issue: 1095, tool: 'tools/perf/transport-1095-probe.mjs', date: new Date().toISOString(), node: process.version,
  browser: browserVersion, settings: { seconds, bytes, runs, seed, tickMs: TICK, profiles: chosen }, results };
if (args.get('out')) await writeFile(args.get('out'), JSON.stringify(record, null, 1) + '\n');
setTimeout(() => process.exit(0), 200);
