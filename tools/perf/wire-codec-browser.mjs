// #1130: time decode/encode and sample allocation for candidate wire codecs in a real Chrome.
// Usage: node tools/perf/wire-codec-browser.mjs --corpus=FILE --out=FILE [--rounds=3] [--min-batch-ms=200]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const msgpackrDir = path.join(root, 'node_modules', 'msgpackr');
const ROUTES = {
  '/wire-descriptor-codec.mjs': path.join(here, 'wire-descriptor-codec.mjs'),
  '/wire-msgpackr-codec.mjs': path.join(here, 'wire-msgpackr-codec.mjs'),
  '/wire-slice-schema.mjs': path.join(here, 'wire-slice-schema.mjs'),
  '/msgpackr/index.js': path.join(msgpackrDir, 'index.js'),
  '/msgpackr/pack.js': path.join(msgpackrDir, 'pack.js'),
  '/msgpackr/unpack.js': path.join(msgpackrDir, 'unpack.js'),
  '/msgpackr/iterators.js': path.join(msgpackrDir, 'iterators.js'),
  // #1130 protobuf follow-up (opt-in: runBrowser({ protobuf: true })). The light build is protobufjs' reflection UMD.
  '/wire-protobuf-codec.mjs': path.join(here, 'wire-protobuf-codec.mjs'),
  '/protobufjs/light.min.js': path.join(root, 'node_modules', 'protobufjs', 'dist', 'light', 'protobuf.min.js'),
};
const PAGE = '<!doctype html><meta charset="utf-8"><title>wire codec bench</title><body></body>';

function serve() {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    const file = ROUTES[url];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Runs in the page. Builds codecs, verifies round trips and stores state on window.
async function pageSetup({ corpus, base, protobuf }) {
  const { createDescriptorCodec } = await import(`${base}/wire-descriptor-codec.mjs`);
  const { createMsgpackrCodec } = await import(`${base}/wire-msgpackr-codec.mjs`);
  const { sliceSchema } = await import(`${base}/wire-slice-schema.mjs`);
  const { Packr, Unpackr } = await import(`${base}/msgpackr/index.js`);
  const te = new TextEncoder(), td = new TextDecoder();
  const codecs = {
    json: { encode: m => te.encode(JSON.stringify(m)), decode: b => JSON.parse(td.decode(b)) },
    'json-string': { encode: m => JSON.stringify(m), decode: s => JSON.parse(s), bytes: s => te.encode(s).length },
    descriptor: createDescriptorCodec(sliceSchema(corpus.lists)),
    'msgpackr-inline': createMsgpackrCodec({ Packr, Unpackr }, { mode: 'inline' }),
    'msgpackr-provisioned': createMsgpackrCodec({ Packr, Unpackr }, { mode: 'provisioned', structures: corpus.structures }),
  };
  if (protobuf) {
    await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = `${base}/protobufjs/light.min.js`; s.onload = resolve; s.onerror = reject; document.head.append(s); });
    const { createProtobufCodec } = await import(`${base}/wire-protobuf-codec.mjs`);
    for (const numbers of ['double', 'narrow', 'narrow32']) {
      const P = codecs[`protobuf-${numbers}`] = createProtobufCodec(window.protobuf, sliceSchema(corpus.lists), { numbers });
      // Library only: input already shaped for protobuf, decode without the back-transform (no round-trip check).
      codecs[`protobuf-${numbers}-library-only`] = { raw: true, prepare: m => P.shape(m), encode: s => P.encodeShaped('state', s), decode: b => P.decodeRaw(b) };
    }
  }
  const eq = (a, b) => {
    if (a === b || (a !== a && b !== b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !eq(a[k], b[k])) return false;
    return true;
  };
  const names = Object.keys(codecs), sizes = {};
  for (const [view, msgs] of Object.entries(corpus.views)) {
    sizes[view] = {};
    for (const name of names) {
      const c = codecs[name];
      let first = 0, steady = 0;
      msgs.forEach((m, i) => {
        const enc = c.encode(c.prepare ? c.prepare(m) : m);
        const back = c.decode(enc);
        if (!c.raw && !eq(back, m)) throw new Error(`round trip mismatch: ${name} ${view} message ${i}`);
        const n = c.bytes ? c.bytes(enc) : enc.length;
        if (i === 0) first = n; else steady += n;
      });
      sizes[view][name] = { firstBytes: first, steadyBytesPerMessage: msgs.length > 1 ? steady / (msgs.length - 1) : null };
    }
  }
  const views = {};
  for (const [view, msgs] of Object.entries(corpus.views)) {
    views[view] = { first: [msgs[0]], steady: msgs.slice(1), all: msgs };
    const input = (n, list) => (codecs[n].prepare ? list.map(codecs[n].prepare) : list);
    views[view].input = Object.fromEntries(names.map(n => [n, { first: input(n, views[view].first), steady: input(n, views[view].steady), all: input(n, msgs) }]));
    views[view].enc = Object.fromEntries(names.map(n => [n, {
      first: views[view].input[n].first.map(m => codecs[n].encode(m)), steady: views[view].input[n].steady.map(m => codecs[n].encode(m)),
    }]));
  }
  // Warm every codec on every message once.
  for (const view of Object.values(views)) for (const n of names) {
    for (const m of view.input[n].all) codecs[n].decode(codecs[n].encode(m));
  }
  window.__st = { codecs, views, names, sink: 0 };
  return { names, sizes };
}

// Runs in the page. Times decode and encode per view x subset x codec over rounds.
async function pageTime({ rounds, minBatchMs }) {
  const { codecs, views, names } = window.__st;
  const out = {};
  const batch = (fn, inputs) => {
    if (!inputs.length) return null;
    let iterations = 0, i = 0, sink = 0;
    const t0 = performance.now();
    let now = t0;
    while (now - t0 < minBatchMs) {
      for (let k = 0; k < 16; k++) { sink += fn(inputs[i]) ? 1 : 0; i = (i + 1) % inputs.length; iterations++; }
      now = performance.now();
    }
    window.__st.sink += sink;
    return (now - t0) / iterations;
  };
  for (const view of Object.keys(views)) {
    out[view] = { first: {}, steady: {} };
    for (const sub of ['first', 'steady']) for (const n of names) out[view][sub][n] = { decode: { rounds: [] }, encode: { rounds: [] } };
  }
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? names : [...names].reverse();
    for (const view of Object.keys(views)) for (const sub of ['first', 'steady']) for (const n of order) {
      const c = codecs[n], v = views[view];
      const d = batch(b => c.decode(b), v.enc[n][sub]);
      const e = batch(m => c.encode(m), v.input[n][sub]);
      if (d !== null) out[view][sub][n].decode.rounds.push(d);
      if (e !== null) out[view][sub][n].encode.rounds.push(e);
    }
  }
  return out;
}

// Runs in the page. One allocation pass: op over the steady subset, `passes` times.
function pageAlloc({ view, name, op, passes }) {
  const { codecs, views } = window.__st;
  const c = codecs[name], v = views[view];
  const fn = op === "decode" ? b => c.decode(b) : m => c.encode(m);
  const inputs = op === 'decode' ? v.enc[name].steady : v.input[name].steady;
  let sink = 0;
  for (let p = 0; p < passes; p++) for (let i = 0; i < inputs.length; i++) sink += fn(inputs[i]) ? 1 : 0;
  window.__st.sink += sink;
  return inputs.length * passes;
}

const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const sumSelf = node => (node.selfSize ?? 0) + (node.children ?? []).reduce((t, c) => t + sumSelf(c), 0);

export async function runBrowser({ corpus, rounds = 3, minBatchMs = 200, heapSampling = true, headless = true, protobuf = false }) {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless });
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('page error:', e.message));
    await page.goto(`${base}/`);
    const { names, sizes } = await page.evaluate(pageSetup, { corpus, base, protobuf });
    const timed = await page.evaluate(pageTime, { rounds, minBatchMs });
    const views = {};
    for (const [view, msgs] of Object.entries(corpus.views)) {
      views[view] = { messages: msgs.length, sizes: sizes[view], first: timed[view].first, steady: timed[view].steady, alloc: {} };
      for (const sub of ['first', 'steady']) for (const n of names) for (const op of ['decode', 'encode']) {
        const cell = views[view][sub][n][op];
        cell.medianMs = median(cell.rounds);
      }
    }
    if (heapSampling) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.enable');
      for (const [view, msgs] of Object.entries(corpus.views)) {
        const steadyCount = msgs.length - 1;
        if (steadyCount < 1) continue;
        const jsonBytes = sizes[view].json.steadyBytesPerMessage * steadyCount;
        const passes = Math.max(1, Math.min(200, Math.floor(20e6 / Math.max(1, jsonBytes))));
        for (const n of names) {
          views[view].alloc[n] = {};
          for (const op of ['decode', 'encode']) {
            await cdp.send('HeapProfiler.collectGarbage');
            await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
            const processed = await page.evaluate(pageAlloc, { view, name: n, op, passes });
            const { profile } = await cdp.send('HeapProfiler.stopSampling');
            views[view].alloc[n][`${op}BytesPerMessage`] = sumSelf(profile.head) / processed;
          }
        }
      }
      await cdp.send('HeapProfiler.disable');
    }
    return { chrome: browser.version(), date: new Date().toISOString(), rounds, minBatchMs, views, verify: 'ok' };
  } finally {
    await browser?.close().catch(() => {});
    await new Promise(r => server.close(r));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  const corpusFile = arg('corpus'), outFile = arg('out');
  if (!corpusFile || !outFile) { console.error('usage: --corpus=FILE --out=FILE [--rounds=3] [--min-batch-ms=200]'); process.exit(2); }
  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const result = await runBrowser({ corpus, rounds: Number(arg('rounds', 3)), minBatchMs: Number(arg('min-batch-ms', 200)) });
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`wire-codec-browser: ${result.chrome}, ${Object.keys(result.views).length} views, verify ${result.verify}, wrote ${outFile}`);
  const f = (x, d) => (x == null ? '-' : x.toFixed(d));
  for (const [view, v] of Object.entries(result.views)) {
    for (const n of Object.keys(v.steady)) {
      const s = v.steady[n], a = v.alloc[n];
      console.log(`${view} ${n}: steady dec ${f(s.decode.medianMs, 4)} enc ${f(s.encode.medianMs, 4)} ms; first dec ${f(v.first[n].decode.medianMs, 4)} enc ${f(v.first[n].encode.medianMs, 4)} ms; alloc dec ${f(a?.decodeBytesPerMessage, 0)} enc ${f(a?.encodeBytesPerMessage, 0)} B/msg; ${f(v.sizes[n].steadyBytesPerMessage, 0)} B`);
    }
  }
}
