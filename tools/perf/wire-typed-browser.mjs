// #1130 field-typed comparison (42.54): Chrome encode/decode timing of the deployable minified bundles built by
// wire-typed-bundles.mjs, on the corpus written by wire-typed-comparison.mjs --corpus-out. Every message is checked
// exact (projection -> native -> bytes -> native -> projection) before timing.
// Usage: node tools/perf/wire-typed-browser.mjs --bundles=DIR --corpus=FILE --out=FILE [--rounds=3] [--min-batch-ms=200]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { cliArgs } from '../../tests/helpers/args.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const args = cliArgs();
for (const k of ['bundles', 'corpus', 'out']) if (!args.has(k)) throw new Error(`--${k} required`);
const dir = path.resolve(args.get('bundles')), rounds = Number(args.get('rounds') ?? 3), minBatchMs = Number(args.get('min-batch-ms') ?? 200);
const ROUTES = { '/d.mjs': 'descriptor.min.mjs', '/p.mjs': 'protobuf-static.min.mjs', '/converter.mjs': 'converter.min.mjs' };
const PAGE = '<!doctype html><meta charset="utf-8"><title>typed wire bench</title><body></body>';

async function pageRun({ corpus, rounds, minBatchMs }) {
  const [{ createCodec: createD }, { createCodec: createP }, { typedModel, nativeModel }] = await Promise.all(['/d.mjs', '/p.mjs', '/converter.mjs'].map(u => import(u)));
  const native = nativeModel(typedModel(corpus.lists)), D = createD(), P = createP();
  const te = new TextEncoder(), td = new TextDecoder();
  const eq = (a, b) => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
  };
  const views = {};
  for (const [view, refs] of Object.entries(corpus.views)) {
    const messages = refs, natives = messages.map(native.toNative);
    natives.forEach((n, i) => { for (const c of [D, P]) if (!eq(native.fromNative(c.decode(c.encode(n))), messages[i])) throw new Error(`${c.name} ${view} ${i} not exact`); });
    views[view] = { messages, natives };
  }
  const ops = {
    'json.encode': rows => [m => te.encode(JSON.stringify(m)), rows.messages],
    'json.decode': rows => [b => JSON.parse(td.decode(b)), rows.messages.map(m => te.encode(JSON.stringify(m)))],
    'descriptor.encode': rows => [n => D.encode(n), rows.natives],
    'descriptor.decode': rows => [b => D.decode(b), rows.natives.map(n => D.encode(n).slice())],
    'protobuf-static.encode': rows => [n => P.encode(n), rows.natives],
    'protobuf-static.decode': rows => [b => P.decode(b), rows.natives.map(n => P.encode(n))],
    'convert-to-native.encode': rows => [m => native.toNative(m), rows.messages],
    'convert-from-native.decode': rows => [n => native.fromNative(n), rows.natives.map(n => P.decode(P.encode(n)))],
  };
  let sink = 0;
  const batch = (fn, inputs) => {
    for (const x of inputs) sink += fn(x) ? 1 : 0; // warm
    let n = 0, i = 0; const t0 = performance.now(); let now = t0;
    while (now - t0 < minBatchMs) { for (let k = 0; k < 16; k++) { sink += fn(inputs[i]) ? 1 : 0; i = (i + 1) % inputs.length; n++; } now = performance.now(); }
    return ((now - t0) * 1000) / n;
  };
  const samples = {};
  for (let round = 0; round < rounds; round++) for (const [view, rows] of Object.entries(views)) for (const subset of ['first', 'steady']) {
    const part = subset === 'first' ? { messages: rows.messages.slice(0, 1), natives: rows.natives.slice(0, 1) } : { messages: rows.messages.slice(1), natives: rows.natives.slice(1) };
    const names = Object.keys(ops), order = round % 2 ? names.reverse() : names;
    for (const name of order) { const [fn, inputs] = ops[name](part); ((samples[view] ??= {})[subset] ??= {})[name] ??= []; samples[view][subset][name].push(batch(fn, inputs)); }
  }
  const median = l => [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)];
  return { sink, userAgent: navigator.userAgent, timing: Object.fromEntries(Object.entries(samples).map(([v, s]) => [v, Object.fromEntries(Object.entries(s).map(([sub, e]) =>
    [sub, Object.fromEntries(Object.entries(e).map(([k, l]) => [k, { wallUs: +median(l).toFixed(3) }]))]))])) };
}

const lock = await acquireMachineLock('bench', { mode: 'exclusive' });
const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  const file = ROUTES[url]; if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(dir, file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const corpus = JSON.parse(fs.readFileSync(args.get('corpus'), 'utf8'));
  const result = await page.evaluate(pageRun, { corpus, rounds, minBatchMs });
  fs.writeFileSync(args.get('out'), JSON.stringify({ generatedAt: new Date().toISOString(), browserVersion: browser.version(), corpus: args.get('corpus'), rounds, minBatchMs, ...result, contention: lock.contention() }, null, 1));
  console.log(JSON.stringify({ out: args.get('out'), steadyContestant: result.timing.contestant?.steady }));
} finally { await browser.close(); server.close(); await lock.release(); }
