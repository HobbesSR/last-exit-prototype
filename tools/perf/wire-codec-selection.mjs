// #1130 bounded codec selection witness, isolated from the live protocol: JSON, JSON+deflate,
// a static descriptor/DataView codec and msgpackr records on the players+bodies slice of real
// production broadcast messages. Node timing here; Chrome via wire-codec-browser.mjs (--browser).
// Budgets were declared on #1130 before measurement; 42.49 records the results.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateRawSync, inflateRawSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { Session } from 'node:inspector/promises';
import os from 'node:os';
import { Packr, Unpackr, isNativeAccelerationEnabled } from 'msgpackr';
import { createMatch } from '../../server/match.js';
import { broadcast, remember, spectatorFrame, viewEncoders } from '../../server/room-views.js';
import { createLayerDecoder } from '../../shared/frame-layers.ts';
import { createDiscoveryDecoder } from '../../shared/discovery.ts';
import { liveZoneSize } from '../../map/live.ts';
import { contentById, CONTENT_ID } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { sliceFieldLists } from './wire-slice-fields.mjs';
import { sliceMessage, sliceSchema, provisionedStructures, QUANTA } from './wire-slice-schema.mjs';
import { createDescriptorCodec, Writer, Reader } from './wire-descriptor-codec.mjs';
import { createMsgpackrCodec } from './wire-msgpackr-codec.mjs';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), stride = Number(args.get('stride') ?? 20);
const repeats = Number(args.get('repeats') ?? 3), minBatchMs = Number(args.get('min-batch-ms') ?? 200), CAP = 1200;
for (const n of [ticks, stride, repeats, minBatchMs]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('positive integer options required');
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
const timing = args.has('timing');
const hash = data => createHash('sha256').update(data).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const revision = git('rev-parse', 'HEAD').trim();
// The only runtime change on this branch exports the projection field declarations (no behaviour change).
const DECLARATION_EXPORTS = ['shared/simulation/projection-contract.ts', 'shared/simulation/visibility.ts'];
const json = { name: 'json', encode: m => Buffer.from(JSON.stringify(m)), decode: b => JSON.parse(b.toString()) };
// The capped probe's sections in priority order, and the bodies layer forms it records (helpers below).
const CAPPED_SECTIONS = ['ownPlayer', 'ownBody', 'otherPlayers', 'otherBodies'];
const LAYER_FORMS = ['none', 'plain', 'all', 'set', 'empty'];
const SECTION_TYPES = { ownPlayer: 'Player', ownBody: 'Body', otherPlayers: 'Player', otherBodies: 'Body' };

const lock = await acquireMachineLock('bench', { mode: timing ? 'exclusive' : 'shared' });
let match;
try {
  const bytes = await readFile(args.get('maps-cache')), cache = deserialize(bytes);
  const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
  if (!size || !cache.maps?.length || cache.content !== CONTENT_ID || cache.generator !== 'chain-live-2' || !cache.source) throw new Error('requires a tuned chain-live-2 cache with a source revision (42.47)');
  execFileSync('git', ['diff', '--exit-code', cache.source, '--', 'map', 'shared', 'server', ...DECLARATION_EXPORTS.map(p => `:!${p}`)]);
  const declarationDiff = git('diff', cache.source, '--', ...DECLARATION_EXPORTS);
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));

  // ---- Corpus: real broadcast payloads, with the raw objects JSON.stringify was given ----------------
  const room = { match, clients: new Set(), history: [], ...viewEncoders() }, VIEWS = ['contestant', 'gladiator', 'dev', 'spectator'];
  const corpus = Object.fromEntries(VIEWS.map(v => [v, []])), viewers = {}, rawByPayload = new Map();
  let at = 0, current, verified = 0;
  const stringify = JSON.stringify;
  const add = (view, playerId, dev = false) => {
    const layers = createLayerDecoder(), discovery = createDiscoveryDecoder();
    viewers[view] = playerId;
    room.clients.add({ playerId, dev, stateEncoding: 'json', deliver(payload) {
      const rebuilt = layers.decode(JSON.parse(payload).state);
      const expected = match.project(view === 'spectator' ? spectatorFrame(room) : current, playerId);
      const me = rebuilt.players?.find(p => p.id === playerId);
      if (me?.discovered) me.discovered = [...discovery.decode(me.discovered)];
      assert.deepEqual(rebuilt, JSON.parse(stringify(expected)), `${view} layered reconstruction tick ${at}`); verified++;
      if (at % stride === 0) corpus[view].push({ tick: at, raw: rawByPayload.get(payload), bodies: rebuilt.bodies, viewer: me && { x: me.x, y: me.y } });
      return true;
    } });
  };
  const roster = match.snapshot().players;
  add('contestant', roster.find(p => p.role === 'contestant').id); add('gladiator', roster.find(p => p.role === 'gladiator').id);
  add('dev', undefined, true); add('spectator', undefined);
  for (at = 0; at <= ticks; at++) {
    current = at ? match.advance() : match.snapshot();
    remember(room, current);
    if (at % stride === 0) JSON.stringify = (value, ...rest) => {
      const out = stringify(value, ...rest);
      // Captured before any session parses it; structuredClone keeps undefined and -0 as the encoder would see them.
      if (value?.type === 'state') rawByPayload.set(out, structuredClone(sliceMessage(value)));
      return out;
    };
    try { broadcast(room, current); } finally { JSON.stringify = stringify; rawByPayload.clear(); }
    if (match.phase !== 'live') break;
  }
  const actualTicks = current.tick;
  for (const view of VIEWS) for (const row of corpus[view]) { assert.ok(row.raw, 'raw message captured'); row.ref = JSON.parse(JSON.stringify(row.raw)); }

  // ---- Codecs -------------------------------------------------------------------------------------------
  const lists = sliceFieldLists(), schema = sliceSchema(lists), structures = provisionedStructures(lists);
  const D = createDescriptorCodec(schema), Dq = createDescriptorCodec(schema, { quantize: QUANTA, name: 'descriptor-quantized' });
  const Mi = createMsgpackrCodec({ Packr, Unpackr }), Mp = createMsgpackrCodec({ Packr, Unpackr }, { mode: 'provisioned', structures });
  const quantizeObjects = m => transform(m, false), dequantizeObjects = m => transform(m, true);
  const Mq = { name: 'msgpackr-provisioned-quantized', encode: m => Mp.encode(quantizeObjects(m)), decode: b => dequantizeObjects(Mp.decode(b)) };
  const jsonDeflate = { name: 'json-deflate', encode: m => deflateRawSync(Buffer.from(JSON.stringify(m))), decode: b => JSON.parse(inflateRawSync(b).toString()) };
  const exact = [D, Mi, Mp], all = [json, jsonDeflate, D, Mi, Mp, Dq, Mq];

  // ---- Exactness: every sample, against the JSON round trip of the raw projected object --------------
  const exactness = {}, numbers = { integer: 0, float32: 0, float64: 0 };
  for (const codec of [json, jsonDeflate, ...exact]) {
    const failures = []; let checked = 0;
    for (const view of VIEWS) for (const row of corpus[view]) {
      checked++;
      try { assert.deepStrictEqual(codec.decode(codec.encode(row.raw)), row.ref); }
      catch (error) { if (failures.length < 5) failures.push({ view, tick: row.tick, error: String(error.message).split('\n').slice(0, 12).join('\n') }); else failures.push(null); }
    }
    exactness[codec.name] = { checked, failed: failures.length, examples: failures.filter(Boolean) };
  }
  // Fresh decoders, shuffled order: nothing may depend on an earlier message (reconnect, no sequential table).
  const everyRow = VIEWS.flatMap(v => corpus[v]), shuffled = everyRow.map((r, i) => [((i * 2654435761) >>> 0) % 1000003, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const fresh = { descriptor: 0, 'msgpackr-inline': 0, 'msgpackr-provisioned': 0 };
  for (const row of shuffled) {
    assert.deepStrictEqual(createDescriptorCodec(sliceSchema(lists)).decode(D.encode(row.raw)), row.ref); fresh.descriptor++;
    for (const M of [Mi, Mp]) { assert.deepStrictEqual(M.decode(M.encode(row.raw), M.freshDecoder()), row.ref); fresh[M.name]++; }
  }
  const tableUnchanged = Mp.tableUnchanged();
  // Quantized variants rebuild their rounded reference; other fields exact (bounds checked field by field).
  const quantizedCheck = { checked: 0, maxError: {} };
  for (const row of everyRow) for (const codec of [Dq, Mq]) {
    const back = codec.decode(codec.encode(row.raw)), rounded = dequantizeObjects(quantizeObjects(row.ref));
    assert.deepStrictEqual(back, rounded, codec.name); quantizedCheck.checked++;
    for (const [family, list, fields] of quantizedLists(row.ref, back)) for (let i = 0; i < list[0].length; i++) for (const [field, scale] of Object.entries(fields)) {
      const a = list[0][i][field], b = list[1][i][field]; if (typeof a !== 'number') continue;
      const error = Math.abs(a - b); assert.ok(error <= 0.5 / scale + Math.abs(a) * Number.EPSILON * 2, `${family}.${field}`);
      const key = `${family}.${field}`; quantizedCheck.maxError[key] = Math.max(quantizedCheck.maxError[key] ?? 0, error);
    }
  }
  for (const row of everyRow) countNumbers(row.ref, numbers);

  // ---- Bytes --------------------------------------------------------------------------------------------
  const stats = list => ({ first: list[0], steadyMean: mean(list.slice(1)), max: Math.max(...list) });
  const bytesByView = {};
  for (const view of VIEWS) {
    bytesByView[view] = {};
    for (const codec of all) bytesByView[view][codec.name] = stats(corpus[view].map(row => codec.encode(row.raw).length));
    // Per-socket context takeover: each message deflated with the previous 32 KiB of that socket's stream as
    // its window (a preset dictionary is equivalent to the window contents). Compression-only size.
    for (const [name, codec] of [['json-deflate-context', json], ['descriptor-deflate-context', D], ['msgpackr-provisioned-deflate-context', Mp]]) {
      let window = Buffer.alloc(0); const sizes = [];
      for (const row of corpus[view]) {
        const raw = Buffer.from(codec.encode(row.raw));
        sizes.push(deflateRawSync(raw, window.length ? { dictionary: window } : {}).length);
        window = Buffer.concat([window, raw]).subarray(-32768);
      }
      bytesByView[view][name] = stats(sizes);
    }
    for (const [name, codec] of [['descriptor-deflate', D], ['msgpackr-provisioned-deflate', Mp]])
      bytesByView[view][name] = stats(corpus[view].map(row => deflateRawSync(codec.encode(row.raw)).length));
  }

  // ---- Distinct baselines: the same tick encoded against N different earlier body keyframes -----------
  const distinct = {};
  for (const view of VIEWS) {
    const rows = corpus[view], variantsOf = (i, n) => {
      const baselines = []; for (let j = 1; j <= n; j++) baselines.push(rows[Math.max(0, i - j)].bodies);
      return baselines.map((base, j) => withBodies(rows[i].ref, changesAgainst(base, rows[i].bodies, 100000 + j)));
    };
    distinct[view] = {};
    for (const n of [1, 4, 16]) {
      const variants = []; for (let i = 16; i < rows.length; i++) variants.push(variantsOf(i, n));
      distinct[view][n] = { ticks: variants.length, bytesPerVariant: Object.fromEntries([json, jsonDeflate, D, Mp].map(c =>
        [c.name, mean(variants.flat().map(m => c.encode(m).length))])), variants };
    }
  }

  // ---- Capped packing probe: priority sections, one pass, last record that fits ----------------------
  const capped = {};
  for (const view of VIEWS) {
    capped[view] = { descriptor: [], 'msgpackr-provisioned': [] };
    for (const row of corpus[view]) {
      const sections = prioritySections(row.ref, viewers[view], row.viewer);
      const d = cappedDescriptor(D, sections, CAP), m = cappedMsgpackr(sections, CAP, structures);
      verifyCapped(decodeCappedDescriptor(D, d.encoded), sections, d); verifyCapped(decodeCappedMsgpackr(m.encoded, structures), sections, m);
      for (const [name, result] of [['descriptor', d], ['msgpackr-provisioned', m]]) {
        assert.equal(result.encoded.length, result.bytes, `${name} capped byte count`);
        assert.ok(result.bytes <= CAP || !result.mandatoryFits, `${name} capped within cap`);
        delete result.encoded; capped[view][name].push({ ...result, verified: true });
      }
    }
    for (const name of Object.keys(capped[view])) capped[view][name] = summarizeCapped(capped[view][name]);
  }
  // Review 858's witness: mandatory content alone over the cap must be reported, not hidden.
  {
    const row = corpus.contestant.at(-1), big = structuredClone(row.ref);
    big.state.version = 'v'.repeat(4000);
    big.state.bodies = { k: 7, set: [], drop: Array.from({ length: 200 }, (_, i) => `item:item-${i}`) };
    const s = prioritySections(big, viewers.contestant, row.viewer);
    for (const result of [cappedDescriptor(D, s, CAP), cappedMsgpackr(s, CAP, structures)])
      assert.ok(!result.mandatoryFits && !result.complete && result.mandatoryBytes > CAP, 'oversized mandatory content is reported');
  }

  // ---- Specimens: control (server→client) and input (client→server, measurement only) ---------------
  const specimens = { ping: { type: 'ping', token: '3f9c2a7b1e4d', rtt: 41.73 },
    input: { type: 'input', seq: 18234, x: 0.7071067811865476, y: -0.7071067811865476, aim: 2.356194490192345, attack: true, slot: 2 } };
  const specimenBytes = Object.fromEntries(Object.entries(specimens).map(([k, m]) => [k, Object.fromEntries([json, D, Mi, Mp].map(c => {
    assert.deepStrictEqual(c.decode(c.encode(m)), JSON.parse(JSON.stringify(m))); return [c.name, c.encode(m).length];
  }))]));

  // ---- Timing (exclusive lock) ------------------------------------------------------------------------
  const timings = {};
  if (timing) {
    const subsets = view => ({ first: [corpus[view][0].raw], steady: corpus[view].slice(1).map(r => r.raw) });
    const modes = [json, { name: 'json-string', encode: m => JSON.stringify(m), decode: s => JSON.parse(s) }, jsonDeflate, D, Mi, Mp, Dq, Mq];
    for (const view of VIEWS) {
      timings[view] = {};
      for (const [subset, inputs] of Object.entries(subsets(view))) {
        const cell = timings[view][subset] = {};
        for (const mode of modes) for (const m of inputs) mode.decode(mode.encode(m)); // warm
        for (let round = 0; round < repeats; round++) for (const mode of round % 2 ? [...modes].reverse() : modes) {
          const encoded = inputs.map(m => mode.encode(m));
          ((cell[mode.name] ??= { encode: [], decode: [] }).encode).push(timed(inputs.length, i => mode.encode(inputs[i])));
          cell[mode.name].decode.push(timed(inputs.length, i => mode.decode(encoded[i])));
        }
        for (const t of Object.values(cell)) for (const op of ['encode', 'decode']) t[`${op}Median`] = median(t[op].map(r => r.wallUs)), t[`${op}CpuMedian`] = median(t[op].map(r => r.cpuUs));
      }
      // Per-socket JSON+deflate with context takeover: CPU that scales with sockets, not views.
      const raws = corpus[view].slice(1).map(r => Buffer.from(JSON.stringify(r.raw)));
      timings[view].steady['json-deflate-context-per-socket'] = { encode: [timed(raws.length, (() => { let w = Buffer.alloc(0);
        return i => { if (i === 0) w = Buffer.alloc(0); deflateRawSync(raws[i], w.length ? { dictionary: w } : {}); w = Buffer.concat([w, raws[i]]).subarray(-32768); }; })())] };
      // Distinct baselines: aggregate encode per tick for N variants.
      timings[view].distinct = {};
      for (const n of [1, 4, 16]) {
        const variants = distinct[view][n].variants, cell = timings[view].distinct[n] = {};
        for (const mode of [json, jsonDeflate, D, Mp]) cell[mode.name] = median(Array.from({ length: repeats }, () =>
          timed(variants.length, i => { for (const m of variants[i]) mode.encode(m); }).wallUs));
      }
      // Capped probe encode cost per message.
      const rows = corpus[view], sections = rows.map(r => prioritySections(r.ref, viewers[view], r.viewer));
      timings[view].capped = {
        descriptor: median(Array.from({ length: repeats }, () => timed(sections.length, i => cappedDescriptor(D, sections[i], CAP)).wallUs)),
        'msgpackr-provisioned': median(Array.from({ length: repeats }, () => timed(sections.length, i => cappedMsgpackr(sections[i], CAP, structures)).wallUs)),
      };
    }
    timings.specimens = {};
    for (const [name, m] of Object.entries(specimens)) {
      timings.specimens[name] = {};
      for (const mode of [json, D, Mi, Mp]) { const b = mode.encode(m); timings.specimens[name][mode.name] = { encode: median(Array.from({ length: repeats }, () => timed(1, () => mode.encode(m)).wallUs)), decode: median(Array.from({ length: repeats }, () => timed(1, () => mode.decode(b)).wallUs)) }; }
    }
  }
  for (const view of VIEWS) for (const n of [1, 4, 16]) delete distinct[view][n].variants;

  // ---- Allocation (sampled heap profiler, collected objects included; a separate pass) ---------------
  const allocation = {};
  if (timing) {
    const session = new Session(); session.connect(); await session.post('HeapProfiler.enable');
    for (const view of ['contestant', 'dev']) {
      allocation[view] = {};
      const inputs = corpus[view].slice(1).map(r => r.raw), passes = 20;
      for (const mode of [json, D, Mi, Mp]) {
        const encoded = inputs.map(m => mode.encode(m));
        const sample = async fn => {
          await session.post('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
          for (let p = 0; p < passes; p++) for (let i = 0; i < inputs.length; i++) fn(i);
          const { profile } = await session.post('HeapProfiler.stopSampling');
          return sumSelf(profile.head) / (passes * inputs.length);
        };
        allocation[view][mode.name] = { encodeBytes: await sample(i => mode.encode(inputs[i])), decodeBytes: await sample(i => mode.decode(encoded[i])) };
      }
    }
    session.disconnect();
  }

  // ---- Browser (Chrome) ------------------------------------------------------------------------------
  if (args.has('corpus-out')) await writeFile(args.get('corpus-out'), JSON.stringify({ size: cache.size, lists, structures,
    views: Object.fromEntries(VIEWS.map(v => [v, corpus[v].map(r => r.ref)])) }));
  let browser = null;
  if (args.has('browser')) {
    const { runBrowser } = await import('./wire-codec-browser.mjs');
    browser = await runBrowser({ corpus: { lists, structures, views: Object.fromEntries(VIEWS.map(v => [v, corpus[v].map(r => r.ref)])) }, rounds: repeats, minBatchMs });
  }

  // ---- Footprint and adapter surface ----------------------------------------------------------------
  const file = p => readFile(new URL(p, import.meta.url));
  const loc = text => String(text).split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length;
  const msgpackrFiles = ['index.js', 'pack.js', 'unpack.js', 'iterators.js'];
  const msgpackrSource = Buffer.concat(await Promise.all(msgpackrFiles.map(f => readFile(new URL(`../../node_modules/msgpackr/${f}`, import.meta.url)))));
  const footprint = {
    descriptor: { files: ['wire-descriptor-codec.mjs', 'wire-slice-schema.mjs'], gzipBytes: gzipSync(Buffer.concat([await file('./wire-descriptor-codec.mjs'), await file('./wire-slice-schema.mjs'), Buffer.from(JSON.stringify(lists))])).length,
      codecLines: loc(await file('./wire-descriptor-codec.mjs')), schemaLines: loc(await file('./wire-slice-schema.mjs')) },
    msgpackr: { version: JSON.parse(await file('../../node_modules/msgpackr/package.json')).version, nativeAccelerationInNode: isNativeAccelerationEnabled,
      servedSourceGzipBytes: gzipSync(msgpackrSource).length, minifiedGzipBytes: gzipSync(await file('../../node_modules/msgpackr/dist/index.min.js')).length,
      adapterLines: loc(await file('./wire-msgpackr-codec.mjs')), provisionedTableJsonBytes: Buffer.byteLength(JSON.stringify(structures)), provisionedStructures: structures.length },
  };

  const population = Object.fromEntries(VIEWS.map(v => [v, { players: Math.max(...corpus[v].map(r => r.ref.state.players.length)),
    bodies: Math.max(...corpus[v].map(r => r.bodies?.length ?? 0)) }]));
  const result = { issue: 1130, revision, timing, date: new Date().toISOString(), node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
    sources: Object.fromEntries(await Promise.all(['./wire-codec-selection.mjs', './wire-descriptor-codec.mjs', './wire-msgpackr-codec.mjs', './wire-slice-schema.mjs', './wire-slice-fields.mjs', './wire-codec-browser.mjs']
      .map(async p => [p, hash(String(await file(p)).replace(/\r\n/g, '\n'))]))),
    declarationExportsDiffSha256: hash(declarationDiff.replace(/\r\n/g, '\n')), declarationExportsDiffLines: declarationDiff.split('\n').filter(l => /^[+-][^+-]/.test(l)).length,
    cache: { path: args.get('maps-cache'), sha256: hash(bytes), size: cache.size, seed: cache.seed, content: cache.content, source: cache.source, generatedAt: cache.generatedAt, generator: cache.generator },
    ticks, actualTicks, stride, repeats, minBatchMs, cap: CAP, deliveriesVerified: verified, samples: Object.fromEntries(VIEWS.map(v => [v, corpus[v].length])), population,
    lists, structures, quanta: QUANTA, numbers, exactness, freshDecoders: fresh, provisionedTableUnchanged: tableUnchanged, quantizedCheck,
    bytes: bytesByView, distinct, capped, specimens: specimenBytes, timings, allocation, browser, footprint, contention: lock.contention() };
  await writeFile(args.get('out'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ size: cache.size, out: args.get('out'), exactness: Object.fromEntries(Object.entries(exactness).map(([k, v]) => [k, v.failed])), contention: result.contention }));
} finally { match?.dispose(); lock.release(); }

// ---- helpers -------------------------------------------------------------------------------------------
function mean(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0; }
function median(list) { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function timed(count, fn) {
  const cpu = process.cpuUsage(), start = performance.now(); let n = 0;
  do { for (let i = 0; i < count; i++) { fn(i); n++; } } while (performance.now() - start < minBatchMs);
  const used = process.cpuUsage(cpu);
  return { iterations: n, wallUs: (performance.now() - start) * 1000 / n, cpuUs: (used.user + used.system) / n };
}
function sumSelf(node) { let s = node.selfSize; for (const c of node.children) s += sumSelf(c); return s; }
function countNumbers(value, counts) {
  if (typeof value === 'number') { if (Number.isInteger(value)) counts.integer++; else if (Math.fround(value) === value) counts.float32++; else counts.float64++; }
  else if (value && typeof value === 'object') for (const v of Object.values(value)) countNumbers(v, counts);
}
// Quantization by plain object transform for msgpackr (the descriptor quantizes inside the codec).
function transform(message, inverse) {
  const state = { ...message.state };
  const scaleRecord = (record, fields) => { const copy = { ...record }; for (const [k, s] of Object.entries(fields)) if (typeof copy[k] === 'number') {
    const n = inverse ? copy[k] / s : Math.round(copy[k] * s); if (!inverse && !Number.isSafeInteger(n)) throw new Error('quantization overflow'); copy[k] = n === 0 ? 0 : n; } return copy; };
  if (state.players) state.players = state.players.map(p => scaleRecord(p, QUANTA.Own));
  const b = state.bodies;
  if (Array.isArray(b)) state.bodies = b.map(r => scaleRecord(r, QUANTA.Body));
  else if (b) { state.bodies = { ...b }; for (const k of ['all', 'set']) if (b[k]) state.bodies[k] = b[k].map(r => scaleRecord(r, QUANTA.Body)); }
  return { ...message, state };
}
function quantizedLists(before, after) {
  const out = [[ 'players', [before.state.players, after.state.players], QUANTA.Own ]];
  const a = before.state.bodies, b = after.state.bodies;
  if (Array.isArray(a)) out.push(['bodies', [a, b], QUANTA.Body]);
  else if (a) for (const k of ['all', 'set']) if (a[k]) out.push([`bodies.${k}`, [a[k], b[k]], QUANTA.Body]);
  return out;
}
function changesAgainst(baseline, list, k) {
  const was = new Map((baseline ?? []).map(e => [e.id, JSON.stringify(e)])), present = new Set(list.map(e => e.id));
  const set = list.filter(e => was.get(e.id) !== JSON.stringify(e)), drop = [...was.keys()].filter(id => !present.has(id));
  return { k, ...(set.length ? { set } : {}), ...(drop.length ? { drop } : {}) };
}
function withBodies(message, bodies) { return { ...message, state: { ...message.state, bodies } }; }
// Capped probe (review 858 on PR #1133). Mandatory content is the whole state header (every field but
// players and bodies), the bodies layer's metadata (form, keyframe k, every drop id) and the viewer's
// own player and own body. Optional sections follow in priority order: other players nearest first,
// then the layer's other bodies nearest first (directed views: list order). Every section's count
// slot is reserved before any record is admitted; the first record that does not fit ends packing.
function prioritySections(message, viewerId, at) {
  const { players = [], bodies, ...header } = message.state;
  const dist = r => at ? Math.hypot(r.x - at.x, r.y - at.y) : 0;
  const entries = Array.isArray(bodies) ? bodies : [...(bodies?.all ?? []), ...(bodies?.set ?? [])];
  const mine = b => viewerId !== undefined && b.actorId === viewerId;
  const layer = bodies === undefined ? { form: 'none' } : Array.isArray(bodies) ? { form: 'plain' }
    : { form: bodies.all ? 'all' : bodies.set ? 'set' : 'empty', k: bodies.k, drop: bodies.drop ?? [] };
  return { header, layer, lists: {
    ownPlayer: players.filter(p => p.id === viewerId), ownBody: entries.filter(mine),
    otherPlayers: players.filter(p => p.id !== viewerId).sort((a, b) => dist(a) - dist(b)),
    otherBodies: entries.filter(b => !mine(b)).sort((a, b) => dist(a) - dist(b)) } };
}
function cappedResult(s, sent, bytes, mandatoryFits, mandatoryBytes) {
  const sections = Object.fromEntries(CAPPED_SECTIONS.map(k => [k, { sent: sent[k] ?? 0, total: s.lists[k].length }]));
  return { bytes, mandatoryBytes, mandatoryFits, sections, complete: mandatoryFits && Object.values(sections).every(x => x.sent === x.total) };
}
// Descriptor: header record (State with an empty player list), layer metadata, then four [u16 count]
// sections with back-patched counts. A record that overflows is rewound: one record redone, never the message.
function cappedDescriptor(codec, s, cap) {
  const w = new Writer(2048); codec.header(w, 'state');
  codec.writeValue(w, 'State', { ...s.header, players: [] });
  w.byte(LAYER_FORMS.indexOf(s.layer.form));
  if (s.layer.k !== undefined) { codec.writeValue(w, 'uint', s.layer.k); codec.writeValue(w, { list: 'id' }, s.layer.drop); }
  const slots = {}, sent = {};
  for (const k of CAPPED_SECTIONS) { slots[k] = w.at; w.u16(0); }
  // Sections are written in order after all their slots, so no later section needs space reserved.
  let mandatoryFits = w.at <= cap, mandatoryBytes = w.at, full = !mandatoryFits;
  for (const k of CAPPED_SECTIONS) {
    let n = 0;
    for (const record of full ? [] : s.lists[k]) {
      const mark = w.at; codec.writeValue(w, SECTION_TYPES[k], record);
      if (w.at > cap) { w.at = mark; full = true; if (k === 'ownPlayer' || k === 'ownBody') mandatoryFits = false; break; }
      n++;
    }
    w.view.setUint16(slots[k], n, true); sent[k] = n;
    if (k === 'ownBody') mandatoryBytes = w.at;
  }
  return { ...cappedResult(s, sent, w.at, mandatoryFits, mandatoryBytes), encoded: w.finish() };
}
function decodeCappedDescriptor(codec, bytes) {
  const r = codec.reader(bytes);
  if (codec.readHeader(r) !== 'state') throw new Error('capped: not a state message');
  const header = codec.readValue(r, 'State'), form = LAYER_FORMS[r.byte()], layer = { form };
  if (!['none', 'plain'].includes(form)) { layer.k = codec.readValue(r, 'uint'); layer.drop = codec.readValue(r, { list: 'id' }); }
  const counts = CAPPED_SECTIONS.map(() => r.u16()), lists = {};
  CAPPED_SECTIONS.forEach((k, i) => { lists[k] = Array.from({ length: counts[i] }, () => codec.readValue(r, SECTION_TYPES[k])); });
  if (r.at !== bytes.length) throw new Error('capped: trailing bytes');
  return { header, layer, lists };
}
// msgpackr: the header and layer metadata as one value, then four array16 sections of individually
// packed records (shapes outside the provisioned table carry their definitions each time). Each
// section's 3-byte array header is reserved before records are admitted.
var cappedPackr; // var: the helpers run from top-level code above this line
function cappedMsgpackr(s, cap, structures) {
  cappedPackr ??= new Packr({ useRecords: true, structures: structures.map(k => [...k]), maxSharedStructures: structures.length });
  const parts = [Uint8Array.of(0xd2, 1, 1), Uint8Array.from(cappedPackr.pack({ header: { ...s.header, players: [] }, layer: s.layer }))];
  let used = parts[0].length + parts[1].length + 3 * CAPPED_SECTIONS.length;
  let mandatoryFits = used <= cap, mandatoryBytes = used, full = !mandatoryFits; const sent = {};
  for (const k of CAPPED_SECTIONS) {
    const records = [];
    for (const record of full ? [] : s.lists[k]) {
      const b = Uint8Array.from(cappedPackr.pack(record));
      if (used + b.length > cap) { full = true; if (k === 'ownPlayer' || k === 'ownBody') mandatoryFits = false; break; }
      used += b.length; records.push(b);
    }
    parts.push(Uint8Array.of(0xdc, records.length >> 8, records.length & 0xff), ...records); sent[k] = records.length;
    if (k === 'ownBody') mandatoryBytes = used;
  }
  const encoded = new Uint8Array(used); let at = 0; for (const p of parts) { encoded.set(p, at); at += p.length; }
  return { ...cappedResult(s, sent, used, mandatoryFits, mandatoryBytes), encoded };
}
function decodeCappedMsgpackr(bytes, structures) {
  if (bytes[0] !== 0xd2) throw new Error('capped: bad format');
  const values = new Unpackr({ useRecords: true, mapsAsObjects: true, structures: structures.map(k => [...k]), maxSharedStructures: structures.length }).unpackMultiple(bytes.subarray(3));
  if (values.length !== 1 + CAPPED_SECTIONS.length) throw new Error('capped: section count');
  return { header: values[0].header, layer: values[0].layer, lists: Object.fromEntries(CAPPED_SECTIONS.map((k, i) => [k, values[i + 1]])) };
}
// The retained sections must rebuild exactly: the full header, layer metadata and the admitted prefix of each section.
function verifyCapped(decoded, s, result) {
  assert.deepStrictEqual(decoded.header, { ...s.header, players: [] }, 'capped header');
  assert.deepStrictEqual(decoded.layer, s.layer, 'capped layer metadata');
  for (const k of CAPPED_SECTIONS) assert.deepStrictEqual(decoded.lists[k], s.lists[k].slice(0, result.sections[k].sent), `capped ${k}`);
}
function summarizeCapped(rows) {
  const section = k => ({ sent: mean(rows.map(r => r.sections[k].sent)), total: mean(rows.map(r => r.sections[k].total)) });
  return { messages: rows.length, meanBytes: mean(rows.map(r => r.bytes)), meanMandatoryBytes: mean(rows.map(r => r.mandatoryBytes)),
    mandatoryOverflow: rows.filter(r => !r.mandatoryFits).length, verified: rows.filter(r => r.verified).length,
    sections: Object.fromEntries(CAPPED_SECTIONS.map(k => [k, section(k)])), complete: rows.filter(r => r.complete).length };
}
