// #1130 field-typed comparison (42.54): the descriptor codec (D) against stock protobuf (P), both generated from one
// per-field type model (wire-typed-schema.mjs) and encoding the same native objects, on real v4 broadcast state
// messages. Scope, budgets and the decision rule were posted on #1130 (comment 15982) before measurement.
// Usage: node tools/perf/wire-typed-comparison.mjs --maps-cache=FILE --out=FILE [--corpus-out=FILE] [--timing]
//   [--protobuf-static=FILE] (pbjs static module; otherwise protobufjs reflection, whose generated code is the same)
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { broadcast, remember, viewEncoders } from '../../server/room-views.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { loadCachedMatch } from './wire-cached-match.mjs';
import { typedFieldLists } from './wire-typed-fields.mjs';
import { sliceMessage, typedModel, nativeModel, descriptorSchema, protoDescriptor } from './wire-typed-schema.mjs';
import { createDescriptorCodec } from './wire-descriptor-codec.mjs';
import { createTypedProtobufCodec } from './wire-typed-protobuf.mjs';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), stride = Number(args.get('stride') ?? 20);
const rounds = Number(args.get('rounds') ?? 3), minBatchMs = Number(args.get('min-batch-ms') ?? 200);
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
const timing = args.has('timing');
const hash = data => createHash('sha256').update(data).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
// A fixed key: IDs are keyed and sized as in a live room (#1164), and the corpus is reproducible.
const WIRE_KEY = [0x2545f491, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
const VIEWS = ['contestant', 'gladiator', 'dev', 'spectator'];

const lock = await acquireMachineLock('bench', { mode: timing ? 'exclusive' : 'shared' });
let match;
try {
  const loaded = await loadCachedMatch(args.get('maps-cache'), { wireKey: WIRE_KEY });
  match = loaded.match;

  // ---- Corpus: the objects production broadcast hands JSON.stringify, sliced -------------------------------
  const room = { match, clients: new Set(), history: [], ...viewEncoders() };
  const corpus = Object.fromEntries(VIEWS.map(v => [v, []]));
  const roster = match.snapshot().players, payloadView = new Map();
  const add = (view, playerId, dev = false) => room.clients.add({ playerId, dev, stateEncoding: 'json', deliver(payload) { const v = payloadView.get(payload); if (v) corpus[view].push(v); return true; } });
  add('contestant', roster.find(p => p.role === 'contestant').id); add('gladiator', roster.find(p => p.role === 'gladiator').id);
  add('dev', undefined, true); add('spectator', undefined);
  const stringify = JSON.stringify;
  let at = 0, current;
  for (at = 0; at <= ticks; at++) {
    current = at ? match.advance() : match.snapshot();
    remember(room, current);
    if (at % stride === 0) JSON.stringify = (value, ...rest) => {
      const out = stringify(value, ...rest);
      // structuredClone keeps undefined and -0 as the encoder would see them; ref is the JSON round trip.
      if (value?.type === 'state') { const raw = structuredClone(sliceMessage(value)); payloadView.set(out, { tick: at, raw, ref: JSON.parse(stringify(raw)) }); }
      return out;
    };
    try { broadcast(room, current); } finally { JSON.stringify = stringify; payloadView.clear(); }
    if (match.phase !== 'live') break;
  }
  const everyRow = VIEWS.flatMap(v => corpus[v]);
  for (const view of VIEWS) assert.ok(corpus[view].length > 1, `${view} samples`);

  // ---- Codecs -------------------------------------------------------------------------------------------
  const lists = typedFieldLists(), model = typedModel(lists), native = nativeModel(model), descriptor = protoDescriptor(native);
  const json = { name: 'json', encode: m => Buffer.from(stringify(m)), decode: b => JSON.parse(b.toString()), projection: true };
  const D = createDescriptorCodec(descriptorSchema(native), { name: 'descriptor' });
  const D64 = createDescriptorCodec(descriptorSchema(native, { exact: 'f64' }), { name: 'descriptor-exact-f64' });
  const staticPath = args.get('protobuf-static');
  const types = staticPath ? await import(pathToFileURL(staticPath).href) : await reflectionTypes(descriptor);
  const P = createTypedProtobufCodec(types, { version: native.version, root: native.root, name: staticPath ? 'protobuf-static' : 'protobuf-reflection' });
  const typedCodecs = [D, P, D64];
  // D's encode/decode take { type, ...native }-free native objects: wrap D to the same message-free interface.
  // D's message record carries a zero-byte const `type`; encodeAs writes the native record directly, and the
  // converter ignores the decoded `type`.
  for (const c of [D, D64]) c.encode = n => c.encodeAs('state', n);

  // ---- Exactness: projection -> native -> bytes -> native -> projection, against the JSON round trip -------
  const exactness = {};
  for (const row of everyRow) row.native = native.toNative(row.raw);
  for (const codec of typedCodecs) {
    const failures = [];
    for (const row of everyRow) {
      try { assert.deepStrictEqual(native.fromNative(codec.decode(codec.encode(row.native))), row.ref); }
      catch (error) { failures.push({ tick: row.tick, error: String(error.message).split('\n').slice(0, 14).join('\n') }); }
    }
    exactness[codec.name] = { checked: everyRow.length, failed: failures.length, examples: failures.slice(0, 3) };
  }
  // Fresh codecs, shuffled order: nothing may depend on an earlier message.
  const shuffled = everyRow.map((r, i) => [((i * 2654435761) >>> 0) % 1000003, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  let fresh = 0;
  for (const row of shuffled) {
    const d = createDescriptorCodec(descriptorSchema(native));
    assert.deepStrictEqual(native.fromNative(d.decode(D.encode(row.native))), row.ref);
    assert.deepStrictEqual(native.fromNative(createTypedProtobufCodec(types, { version: native.version, root: native.root }).decode(P.encode(row.native))), row.ref);
    fresh++;
  }

  // ---- Bytes ----------------------------------------------------------------------------------------------
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const bytes = {};
  for (const view of VIEWS) {
    bytes[view] = {};
    for (const codec of [json, ...typedCodecs]) {
      const sizes = corpus[view].map(row => codec.encode(codec.projection ? row.raw : row.native).length);
      bytes[view][codec.name] = { first: sizes[0], steadyMean: mean(sizes.slice(1)), max: Math.max(...sizes) };
    }
  }

  // ---- Malformed input: decode then the converter (production would run both) must refuse --------------
  const accept = (codec, b) => native.fromNative(codec.decode(b));
  const safety = {};
  const picks = VIEWS.flatMap(v => [1, Math.floor(corpus[v].length / 2), corpus[v].length - 1].map(i => corpus[v][i]));
  for (const codec of [D, P]) {
    const s = safety[codec.name] = { truncations: 0, truncationsAccepted: 0, trailingAccepted: 0, headerAccepted: 0, corruption: { refused: 0, different: 0, same: 0, worstMs: 0 }, crafted: {} };
    for (const row of picks) {
      const good = codec.encode(row.native);
      for (let cut = 0; cut < good.length; cut++) { s.truncations++; try { accept(codec, good.subarray(0, cut)); s.truncationsAccepted++; } catch {} }
      try { accept(codec, Uint8Array.of(...good, 0)); s.trailingAccepted++; } catch {}
      for (const at of [0, 1, 2]) { const b = good.slice(); b[at] ^= 0x40; try { accept(codec, b); s.headerAccepted++; } catch {} }
    }
    // Seeded single-byte corruption past the header.
    let seed = 1130;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 2000; i++) {
      const row = picks[i % picks.length], b = codec.encode(row.native).slice(), at = 4 + Math.floor(rand() * (b.length - 4));
      b[at] = (b[at] + 1 + Math.floor(rand() * 255)) & 255;
      const t0 = performance.now();
      try { const back = accept(codec, b); try { assert.deepStrictEqual(back, row.ref); s.corruption.same++; } catch { s.corruption.different++; } }
      catch { s.corruption.refused++; }
      s.corruption.worstMs = Math.max(s.corruption.worstMs, performance.now() - t0);
    }
  }
  // Crafted: a list or length prefix claiming far more than the bytes hold must refuse before allocating.
  {
    const craft = (prefix, tail) => Uint8Array.of(...prefix, ...tail);
    const time = (codec, b) => { const t0 = performance.now(); let refused = false; try { accept(codec, b); } catch { refused = true; } return { refused, ms: +(performance.now() - t0).toFixed(3) }; };
    const varint = v => { const out = []; while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); } out.push(v); return out; };
    // P: body length correct, the body's first field a length-delimited one claiming 2^31 bytes.
    const pBody = [0x0a, ...varint(2 ** 31)];
    safety[P.name].crafted.lengthDelimited2e31 = time(P, craft([0xd4, native.version, 1, ...varint(pBody.length)], pBody));
    // D: State's presence mask, then the required header fields, with players' count claiming 2^31.
    const good = D.encode(picks[0].native), dState = createDescriptorCodec(descriptorSchema(native));
    safety[D.name].crafted.hugeListCount = time(D, craft(good.subarray(0, 3), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...varint(2 ** 31)]));
    void dState;
  }

  // ---- Node timing: alternating rounds, wall and process CPU per message --------------------------------
  let timingReport = null;
  if (timing) {
    const batch = (fn, inputs) => {
      let n = 0, i = 0, sink = 0; const c0 = process.cpuUsage(), t0 = performance.now(); let now = t0;
      while (now - t0 < minBatchMs) { for (let k = 0; k < 16; k++) { sink += fn(inputs[i]) ? 1 : 0; i = (i + 1) % inputs.length; n++; } now = performance.now(); }
      const c = process.cpuUsage(c0);
      return { wallUs: ((now - t0) * 1000) / n, cpuUs: (c.user + c.system) / n, sink };
    };
    const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const ops = {
      json: { encode: rows => [r => stringify(r.raw), rows], decode: rows => [s => JSON.parse(s), rows.map(r => stringify(r.raw))] },
      ...Object.fromEntries(typedCodecs.map(c => [c.name, { encode: rows => [r => c.encode(r.native), rows], decode: rows => [b => c.decode(b), rows.map(r => c.encode(r.native))] }])),
      'convert-to-native': { encode: rows => [r => native.toNative(r.raw), rows] },
      'convert-from-native': { decode: rows => [n => native.fromNative(n), rows.map(r => P.decode(P.encode(r.native)))] },
    };
    const samples = {};
    for (let round = 0; round < rounds; round++) for (const view of VIEWS) for (const subset of ['first', 'steady']) {
      const rows = subset === 'first' ? corpus[view].slice(0, 1) : corpus[view].slice(1);
      const names = Object.keys(ops), order = round % 2 ? names.reverse() : names;
      for (const name of order) for (const op of ['encode', 'decode']) {
        if (!ops[name][op]) continue;
        const [fn, inputs] = ops[name][op](rows), r = batch(fn, inputs);
        ((samples[view] ??= {})[subset] ??= {})[`${name}.${op}`] ??= [];
        samples[view][subset][`${name}.${op}`].push(r);
      }
    }
    timingReport = Object.fromEntries(Object.entries(samples).map(([view, subsets]) => [view, Object.fromEntries(Object.entries(subsets).map(([subset, entries]) =>
      [subset, Object.fromEntries(Object.entries(entries).map(([k, list]) => [k, { wallUs: +median(list.map(x => x.wallUs)).toFixed(3), cpuUs: +median(list.map(x => x.cpuUs)).toFixed(3) }]))]))]));
  }

  const report = {
    issue: 1130, record: '42.54', generatedAt: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain', '--', 'tools/perf', 'shared', 'server', 'map').trim().split('\n').filter(Boolean),
    sources: Object.fromEntries(['wire-typed-comparison.mjs', 'wire-typed-schema.mjs', 'wire-typed-fields.mjs', 'wire-typed-protobuf.mjs', 'wire-descriptor-codec.mjs', 'wire-cached-match.mjs']
      .map(f => [f, hash(readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n'))]).concat(staticPath ? [['protobuf-static', staticPath]] : [])),
    cache: loaded.provenance, node: process.version, cpu: os.cpus()[0]?.model, wireKey: 'fixed (tool constant)',
    samples: Object.fromEntries(VIEWS.map(v => [v, corpus[v].length])), ticks: current.tick, stride,
    exactness, freshShuffled: fresh, bytes, safety, timing: timingReport, contention: lock.contention(),
  };
  if (args.has('corpus-out')) await writeFile(args.get('corpus-out'), stringify({ lists, views: Object.fromEntries(VIEWS.map(v => [v, corpus[v].map(r => r.ref)])) }));
  await writeFile(args.get('out'), stringify(report, null, 1));
  console.log(stringify({ exactness: Object.fromEntries(Object.entries(exactness).map(([k, v]) => [k, v.failed])), bytes: Object.fromEntries(VIEWS.map(v => [v, Object.fromEntries(Object.entries(bytes[v]).map(([k, b]) => [k, Math.round(b.steadyMean)]))])) }));
  if (Object.values(exactness).some(e => e.failed)) { console.log(stringify(exactness, null, 1).slice(0, 4000)); process.exitCode = 1; }
} finally { match?.close?.(); await lock.release(); }

/** Node: a reflection root from the descriptor (protobufjs light build); its codegen is what pbjs emits statically. */
async function reflectionTypes(descriptor) {
  const { default: protobuf } = await import('protobufjs/light.js');
  const root = protobuf.Root.fromJSON(descriptor);
  return Object.fromEntries(root.nestedArray.filter(t => t.fields).map(t => [t.name, t]));
}
