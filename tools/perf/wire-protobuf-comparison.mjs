// #1130 follow-up: stock protobuf (protobufjs) head-to-head with the descriptor codec D on 42.49's slice. Reads the
// corpus written by wire-codec-selection.mjs --corpus-out (the same real production messages) and re-measures JSON,
// D and msgpackr-provisioned in the same process so the ratios are paired. Budgets: #1130 comment 15382.
// Usage: node tools/perf/wire-protobuf-comparison.mjs --corpus=FILE --out=FILE [--timing] [--browser] [--repeats=3] [--min-batch-ms=200]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Session } from 'node:inspector/promises';
import os from 'node:os';
import protobuf from 'protobufjs/light.js';
import { Packr, Unpackr } from 'msgpackr';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { sliceSchema } from './wire-slice-schema.mjs';
import { createDescriptorCodec } from './wire-descriptor-codec.mjs';
import { createMsgpackrCodec } from './wire-msgpackr-codec.mjs';
import { createProtobufCodec } from './wire-protobuf-codec.mjs';
import { semanticSpecimens, checkSemantics, checkMalformed, craftedInputs } from './wire-codec-safety.mjs';

const args = cliArgs(), timing = args.has('timing');
const repeats = Number(args.get('repeats') ?? 3), minBatchMs = Number(args.get('min-batch-ms') ?? 200);
if (!args.has('corpus') || !args.has('out')) throw new Error('--corpus and --out required');
const hash = data => createHash('sha256').update(data).digest('hex');
const file = p => readFile(new URL(p, import.meta.url));

const lock = await acquireMachineLock('bench', { mode: timing ? 'exclusive' : 'shared' });
try {
  const corpusText = await readFile(args.get('corpus'), 'utf8'), corpus = JSON.parse(corpusText);
  const VIEWS = Object.keys(corpus.views), schema = () => sliceSchema(corpus.lists);
  const json = { name: 'json', encode: m => Buffer.from(JSON.stringify(m)), decode: b => JSON.parse(b.toString()) };
  const D = createDescriptorCodec(schema());
  const Mp = createMsgpackrCodec({ Packr, Unpackr }, { mode: 'provisioned', structures: corpus.structures });
  const P64 = createProtobufCodec(protobuf, schema(), { numbers: 'double' });
  const Pn = createProtobufCodec(protobuf, schema(), { numbers: 'narrow' });
  const Pn32 = createProtobufCodec(protobuf, schema(), { numbers: 'narrow32' });
  const protobufs = [P64, Pn, Pn32], codecs = [json, D, Mp, ...protobufs];

  // ---- Exactness: every sample against its JSON round trip, then fresh codecs in shuffled order ----------
  const exactness = {};
  for (const codec of codecs) {
    let checked = 0;
    for (const view of VIEWS) for (const m of corpus.views[view]) { assert.deepStrictEqual(codec.decode(codec.encode(m)), m, `${codec.name} ${view}`); checked++; }
    exactness[codec.name] = { checked, failed: 0 };
  }
  const everyRow = VIEWS.flatMap(v => corpus.views[v]);
  const shuffled = everyRow.map((r, i) => [((i * 2654435761) >>> 0) % 1000003, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  for (const encoder of protobufs) {
    const numbers = encoder.name.replace('protobuf-', '');
    for (const m of shuffled) assert.deepStrictEqual(createProtobufCodec(protobuf, schema(), { numbers }).decode(encoder.encode(m)), m, 'fresh decoder');
  }

  // ---- Bytes ------------------------------------------------------------------------------------------------
  const mean = l => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
  const bytes = {};
  for (const view of VIEWS) {
    bytes[view] = {};
    for (const c of codecs) {
      const sizes = corpus.views[view].map(m => c.encode(m).length);
      bytes[view][c.name] = { first: sizes[0], steadyMean: mean(sizes.slice(1)), max: Math.max(...sizes) };
    }
    const j = bytes[view].json;
    for (const c of codecs) Object.assign(bytes[view][c.name], { steadyPctJson: +(100 * bytes[view][c.name].steadyMean / j.steadyMean).toFixed(1),
      firstPctJson: +(100 * bytes[view][c.name].first / j.first).toFixed(1),
      steadyVsDescriptor: +(bytes[view][c.name].steadyMean / bytes[view].descriptor.steadyMean).toFixed(3) });
  }
  // Where protobuf's extra bytes go: field tags and length prefixes, measured by encoding each top-level section alone.
  const specimens = { ping: { type: 'ping', token: '3f9c2a7b1e4d', rtt: 41.73 },
    input: { type: 'input', seq: 18234, x: 0.7071067811865476, y: -0.7071067811865476, aim: 2.356194490192345, attack: true, slot: 2 } };
  const specimenBytes = Object.fromEntries(Object.entries(specimens).map(([k, m]) => [k, Object.fromEntries(codecs.map(c => {
    assert.deepStrictEqual(c.decode(c.encode(m)), JSON.parse(JSON.stringify(m))); return [c.name, c.encode(m).length];
  }))]));

  // ---- Timing (exclusive lock): full codec, and protobuf's library-only paths (no adapter) -----------------
  const timings = {};
  if (timing) {
    const libOnly = P => ({ name: `${P.name}-library-only`, prepare: m => P.shape(m), encode: s => P.encodeShaped('state', s), decode: b => P.decodeRaw(b) });
    const adapterOnly = P => ({ name: `${P.name}-adapter-only`, prepare: m => m, encode: m => P.shape(m), decode: null });
    const modes = [...codecs, ...protobufs.map(libOnly), ...protobufs.map(adapterOnly)];
    for (const view of VIEWS) {
      timings[view] = {};
      for (const [subset, raw] of Object.entries({ first: [corpus.views[view][0]], steady: corpus.views[view].slice(1) })) {
        const cell = timings[view][subset] = {};
        const inputs = new Map(modes.map(mode => [mode, raw.map(m => (mode.prepare ? mode.prepare(m) : m))]));
        const encoded = new Map(modes.map(mode => [mode, mode.decode ? inputs.get(mode).map(m => mode.encode(m)) : null]));
        for (const mode of modes) for (let i = 0; i < raw.length; i++) { mode.encode(inputs.get(mode)[i]); mode.decode?.(encoded.get(mode)[i]); } // warm
        for (let round = 0; round < repeats; round++) for (const mode of round % 2 ? [...modes].reverse() : modes) {
          const t = cell[mode.name] ??= { encode: [], decode: [] }, ins = inputs.get(mode), enc = encoded.get(mode);
          t.encode.push(timed(raw.length, i => mode.encode(ins[i])));
          if (mode.decode) t.decode.push(timed(raw.length, i => mode.decode(enc[i])));
        }
        for (const t of Object.values(cell)) for (const op of ['encode', 'decode']) if (t[op].length) {
          t[`${op}Median`] = median(t[op].map(r => r.wallUs)); t[`${op}CpuMedian`] = median(t[op].map(r => r.cpuUs));
        }
      }
    }
  }

  // ---- Allocation (sampled heap profiler, collected objects included) -----------------------------------
  const allocation = {};
  if (timing) {
    const session = new Session(); session.connect(); await session.post('HeapProfiler.enable');
    for (const view of ['contestant', 'dev']) {
      allocation[view] = {};
      const inputs = corpus.views[view].slice(1), passes = 20;
      for (const mode of codecs) {
        const encoded = inputs.map(m => mode.encode(m));
        const sample = async fn => {
          await session.post('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
          for (let p = 0; p < passes; p++) for (let i = 0; i < inputs.length; i++) fn(i);
          const { profile } = await session.post('HeapProfiler.stopSampling');
          return sumSelf(profile.head) / (passes * inputs.length);
        };
        allocation[view][mode.name] = { encodeBytes: await sample(i => mode.encode(inputs[i])), decodeBytes: await sample(i => mode.decode(encoded[i])) };
      }
      for (const mode of codecs) Object.assign(allocation[view][mode.name], {
        encodeVsJson: +(allocation[view][mode.name].encodeBytes / allocation[view].json.encodeBytes).toFixed(2),
        decodeVsJson: +(allocation[view][mode.name].decodeBytes / allocation[view].json.decodeBytes).toFixed(2) });
    }
    session.disconnect();
  }

  // ---- Semantics and malformed input (the #1130 suite; protobuf's own crafted inputs) ----------------------
  const safety = {};
  const base = corpus.views.contestant[0], small = [specimens.ping, { type: 'input', seq: 3, x: 1, y: -1, attack: true, moveSlot: { from: 1, to: 2 } }];
  for (const codec of [D, ...protobufs]) {
    const semantics = checkSemantics(codec, semanticSpecimens(base));
    const samples = [];
    for (const view of Object.values(corpus.views)) for (const m of view.slice(0, 2)) samples.push(codec.encode(m));
    for (const m of small) samples.push(codec.encode(m));
    const malformed = checkMalformed(codec, samples, { crafted: codec === D ? craftedInputs('descriptor') : protobufCrafted() });
    safety[codec.name] = {
      semantics: { specimens: semantics.length, exact: semantics.filter(r => r.outcome === 'exact').length,
        acceptedRefusals: semantics.filter(r => r.ok && r.outcome !== 'exact').map(r => `${r.name} [${r.outcome}] ${r.detail}`),
        failures: semantics.filter(r => !r.ok).map(r => `${r.name} [${r.outcome}] ${r.detail}`) },
      malformed,
    };
  }

  // ---- Chrome (opt-in): the shared #1130 browser runner with protobuf added ---------------------------------
  let browser = null;
  if (args.has('browser')) {
    const { runBrowser } = await import('./wire-codec-browser.mjs');
    browser = await runBrowser({ corpus, rounds: repeats, minBatchMs, protobuf: true });
  }

  // ---- Footprint and surface ------------------------------------------------------------------------------
  const loc = text => String(text).split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length;
  const gz = buf => gzipSync(buf).length, pkg = p => readFile(new URL(`../../node_modules/protobufjs/${p}`, import.meta.url));
  const generated = Buffer.from(Pn.generatedSource()), generated64 = Buffer.from(P64.generatedSource()), generated32 = Buffer.from(Pn32.generatedSource());
  const descriptorJson = Buffer.from(JSON.stringify(Pn.descriptor));
  const footprint = {
    protobufjs: { version: JSON.parse(await pkg('package.json')).version, lightMinGzip: gz(await pkg('dist/light/protobuf.min.js')),
      minimalMinGzip: gz(await pkg('dist/minimal/protobuf.min.js')), fullMinGzip: gz(await pkg('dist/protobuf.min.js')) },
    // Static code would ship protobufjs' minimal runtime plus generated encode/decode; the reflection codegen output
    // (unminified) stands in for that generated code, so this is an upper estimate.
    generatedCodeGzip: { narrow: gz(generated), double: gz(generated64), narrow32: gz(generated32) },
    descriptorJsonGzip: gz(descriptorJson), protoMessages: Object.keys(Pn.descriptor.nested).length,
    adapterLines: loc(await file('./wire-protobuf-codec.mjs')), adapterGzip: gz(await file('./wire-protobuf-codec.mjs')),
    descriptorCodecLines: loc(await file('./wire-descriptor-codec.mjs')), descriptorGzip: gz(Buffer.concat([await file('./wire-descriptor-codec.mjs'), await file('./wire-slice-schema.mjs'), Buffer.from(JSON.stringify(corpus.lists))])),
  };
  footprint.protobufStaticEstimateGzip = footprint.protobufjs.minimalMinGzip + footprint.generatedCodeGzip.narrow + footprint.adapterGzip;
  footprint.protobufReflectionGzip = footprint.protobufjs.lightMinGzip + footprint.adapterGzip + gz(Buffer.from(JSON.stringify(corpus.lists)));

  const result = { issue: 1130, followUp: 'protobuf head-to-head', budgetsComment: 15382, timing, date: new Date().toISOString(),
    node: process.version, platform: process.platform, cpu: os.cpus()[0].model, revision: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    corpus: { path: args.get('corpus'), sha256: hash(corpusText), size: corpus.size, samples: Object.fromEntries(VIEWS.map(v => [v, corpus.views[v].length])) },
    sources: Object.fromEntries(await Promise.all(['./wire-protobuf-comparison.mjs', './wire-protobuf-codec.mjs', './wire-descriptor-codec.mjs', './wire-slice-schema.mjs', './wire-codec-safety.mjs', './wire-msgpackr-codec.mjs', './wire-codec-browser.mjs']
      .map(async p => [p, hash(String(await file(p)).replace(/\r\n/g, '\n'))]))),
    repeats, minBatchMs, exactness, freshDecodersChecked: shuffled.length * protobufs.length, bytes, specimens: specimenBytes, timings, allocation, browser, safety, footprint,
    protoDescriptor: Pn.descriptor, contention: lock.contention() };
  await writeFile(args.get('out'), JSON.stringify(result, null, 1) + '\n');
  const brief = Object.fromEntries(VIEWS.map(v => [v, Object.fromEntries(codecs.map(c => [c.name, bytes[v][c.name].steadyPctJson]))]));
  console.log(JSON.stringify({ size: corpus.size, out: args.get('out'), steadyPctJson: brief, contention: result.contention }));
} finally { lock.release(); }

function median(list) { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function timed(count, fn) {
  const cpu = process.cpuUsage(), start = performance.now(); let n = 0;
  do { for (let i = 0; i < count; i++) { fn(i); n++; } } while (performance.now() - start < minBatchMs);
  const used = process.cpuUsage(cpu);
  return { iterations: n, wallUs: (performance.now() - start) * 1000 / n, cpuUs: (used.user + used.system) / n };
}
function sumSelf(node) { let s = node.selfSize; for (const c of node.children) s += sumSelf(c); return s; }

// Hostile protobuf inputs behind P's header (d3, version 1, message id 1 = state, varint body length; the length is
// set to match each body so the protobuf decoder itself is exercised). Field numbers follow the
// generated descriptor: Message_state.state is field 1 (the const type takes no field number), and State.version
// is field 1, a string. Field 15 is unknown to every message.
function protobufCrafted() {
  const varint = n => { const b = []; while (n >= 0x80) { b.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); } b.push(n); return b; };
  const MAX = 1 << 20, framed = body => Uint8Array.from([0xd3, 1, 1, ...varint(body.length), ...body]);
  const bytesOf = (head, ...parts) => framed(parts.flat()); // head is the conventional placeholder; framing adds the real one
  const head = [];
  const nestedGroups = framed(new Array(100000).fill(0x7b)); // unknown field 15, start-group, 100000 deep
  const oversize = new Uint8Array(MAX + 1); oversize.set([0xd3, 1, 1]);
  const manyUnknown = framed(new Array(200000).fill(0).map((_, i) => (i % 2 ? 0x01 : 0x78))); // field 15 varint 1, repeated
  return [
    { name: 'declared body length longer than the bytes', bytes: Uint8Array.from([0xd3, 1, 1, 0x7f, 0x0a, 0x00]) },
    { name: 'declared body length varint of 4 continuation bytes', bytes: Uint8Array.from([0xd3, 1, 1, 0xff, 0xff, 0xff, 0xff, 0x01]) },
    { name: 'state length 2**31, no payload', bytes: bytesOf(head, [0x0a], varint(2 ** 31)) },
    { name: 'state length 2**31 with 16 bytes', bytes: bytesOf(head, [0x0a], varint(2 ** 31), new Array(16).fill(0)) },
    { name: 'version string length 2**32 inside state', bytes: bytesOf(head, [0x0a, 0x06, 0x0a], varint(2 ** 32)) },
    { name: 'varint of 11 continuation bytes', bytes: bytesOf(head, [0x0a], new Array(11).fill(0xff), [0]) },
    { name: '100000 nested unknown start-groups', bytes: nestedGroups },
    { name: '200000 unknown varint fields (skipped)', bytes: manyUnknown },
    { name: 'unknown wire type 7', bytes: bytesOf(head, [0x0f, 0x00]) },
    { name: 'end-group without start', bytes: bytesOf(head, [0x0c]) },
    { name: 'state present but empty (required fields missing)', bytes: bytesOf(head, [0x0a, 0x00]) },
    { name: 'header only (body length 0)', bytes: bytesOf(head) },
    { name: 'header without a length', bytes: Uint8Array.from([0xd3, 1, 1]) },
    { name: 'empty input', bytes: new Uint8Array(0) },
    { name: '1 MiB + 1 bytes (expect refusal by size)', bytes: oversize },
    { name: 'unknown length-delimited field before nothing else', bytes: bytesOf(head, [0x7a], varint(5), [1, 2, 3, 4, 5]) },
    { name: 'control: smallest valid state (expected to decode under double and narrow, whose tick is field 2)', bytes: bytesOf(head, [0x0a, 0x06, 0x0a, 0x00, 0x10, 0x00, 0x1a, 0x00]) },
  ];
}
