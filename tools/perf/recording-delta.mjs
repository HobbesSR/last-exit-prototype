// Recording delta-format evaluation probe (#901). Not a writer, not a format: it measures what
// frames carrying only changed state, with a complete keyframe every K retained frames, would
// cost and save against the current full-state frame (26), over one whole cached match.
//
// Two prototype encodings, both exact (every reconstructed frame's JSON equals the full line):
//   top  - a delta frame carries each top-level state key whose JSON changed, whole.
//   ent  - also descends into plain objects with unchanged key order, and diffs arrays of
//          records keyed by a unique `id` (or `spec.id`) by entity: set, delete, reorder.
// Each delta is against the previous *retained* frame, so a dropped frame never leaves a delta
// depending on missing data. Gzip sizes use one stream per encoding/cadence, as a recording would.
// Worker CPU is estimated from gzip + SHA-256 throughput over each stream's first bytes.
//
// --maps-cache=<room-startup cache> [--ticks=N] [--cadences=20,100,600] [--verify=1] [--out=<json>]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { createGzip, gzipSync } from 'node:zlib';
import { createMatch } from '../../server/match.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { itemsJson } from '../../shared/simulation/ground-items.ts';
import { gatesJson } from '../../shared/simulation/frame-gates.ts';
import { cliArgs } from '../../tests/helpers/args.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const args = cliArgs();
if (!args.has('maps-cache')) throw new Error('--maps-cache is required');
const cache = deserialize(await readFile(args.get('maps-cache')));
const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number);
const maxTicks = Number(args.get('ticks') ?? Infinity);
const cadences = (args.get('cadences') ?? '20,100,600').split(',').map(Number);
const verifyEvery = Number(args.get('verify') ?? 1);
// --kept=1: as the writer does (#655), compare the ground items and gates by their owners' kept JSON and
// hand the encoder the previous list when it is unchanged, so unchanged lists are skipped by identity.
const useKept = args.get('kept') === '1';
const keptLists = { items: { json: undefined, list: undefined, of: itemsJson }, gates: { json: undefined, list: undefined, of: gatesJson } };
function stableLists(state) {
  const out = { ...state };
  for (const [key, last] of Object.entries(keptLists)) {
    if (!Array.isArray(state[key])) continue;
    const json = last.of(state[key]);
    if (json === last.json) out[key] = last.list; else { last.json = json; last.list = Object.freeze(state[key].slice()); out[key] = last.list; }
  }
  return out;
}
const SAMPLE_BYTES = 32 * 1024 * 1024, MAX_STRING = (await import('node:buffer')).constants.MAX_STRING_LENGTH;

// ---- prototype encoder -------------------------------------------------------------------
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = entry => isPlain(entry) ? (entry.id ?? entry.spec?.id) : undefined;
function keyable(list) {
  if (!Array.isArray(list) || !list.length) return false;
  const seen = new Set();
  for (const entry of list) {
    const key = keyOf(entry);
    if ((typeof key !== 'string' && typeof key !== 'number') || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
const presentKeys = object => Object.keys(object).filter(key => object[key] !== undefined && typeof object[key] !== 'function');
// A shadow remembers what was last emitted, as JSON text, without retaining the frame.
function shadow(value, depth, json) {
  if (depth > 1 && keyable(value)) {
    const texts = new Map();
    for (const entry of value) texts.set(keyOf(entry), { ref: Object.isFrozen(entry) ? entry : null, json: JSON.stringify(entry) });
    return { kind: 'a', ref: Object.isFrozen(value) ? value : null, ids: value.map(keyOf), texts };
  }
  if (depth >= 1 && isPlain(value)) {
    const keys = presentKeys(value);
    return { kind: 'o', keys, children: Object.fromEntries(keys.map(key => [key, shadow(value[key], depth - 1)])) };
  }
  return { kind: 'v', json: json ?? JSON.stringify(value) };
}
// Returns [shadow, patch text or undefined]. `depth` limits object descent (top = 1).
function diff(prev, value, depth) {
  if (prev.kind === 'o' && isPlain(value)) {
    const keys = presentKeys(value);
    if (keys.length === prev.keys.length && keys.every((key, i) => key === prev.keys[i])) {
      const parts = [], children = {};
      for (const key of keys) {
        const [child, patch] = diff(prev.children[key], value[key], depth - 1);
        children[key] = child;
        if (patch !== undefined) parts.push(`${JSON.stringify(key)}:${patch}`);
      }
      return [{ kind: 'o', keys, children }, parts.length ? `{"o":{${parts.join(',')}}}` : undefined];
    }
  }
  if (prev.kind === 'a' && keyable(value)) {
    if (prev.ref && prev.ref === value) return [prev, undefined];
    const texts = new Map(), ids = [], set = [];
    for (const entry of value) {
      const key = keyOf(entry), old = prev.texts.get(key);
      ids.push(key);
      if (old?.ref && old.ref === entry) { texts.set(key, old); continue; }
      const json = JSON.stringify(entry);
      texts.set(key, { ref: Object.isFrozen(entry) ? entry : null, json });
      if (!old || old.json !== json) set.push(json);
    }
    const del = prev.ids.filter(key => !texts.has(key));
    const expected = prev.ids.filter(key => texts.has(key)).concat(ids.filter(key => !prev.texts.has(key)));
    const reordered = expected.length !== ids.length || expected.some((key, i) => key !== ids[i]);
    const next = { kind: 'a', ref: Object.isFrozen(value) ? value : null, ids, texts };
    if (!set.length && !del.length && !reordered) return [next, undefined];
    const fields = [];
    if (set.length) fields.push(`"s":[${set.join(',')}]`);
    if (del.length) fields.push(`"d":${JSON.stringify(del)}`);
    if (reordered) fields.push(`"r":${JSON.stringify(ids)}`);
    return [next, `{"a":{${fields.join(',')}}}`];
  }
  const json = JSON.stringify(value);
  const next = shadow(value, depth, json);
  if (prev.kind === 'v' && prev.json === json) return [next, undefined];
  if (json === undefined) return [next, '{"u":1}'];
  return [next, `{"v":${json}}`];
}

// ---- prototype reader (engine-free: data patching only) -----------------------------------
function apply(prev, patch) {
  if ('v' in patch) return patch.v;
  if ('u' in patch) return undefined;
  if ('o' in patch) {
    const next = {};
    for (const key of Object.keys(prev)) next[key] = key in patch.o ? apply(prev[key], patch.o[key]) : prev[key];
    return next;
  }
  const byId = new Map(prev.map(entry => [keyOf(entry), entry]));
  const order = prev.map(keyOf);
  for (const id of patch.a.d ?? []) byId.delete(id);
  const added = [];
  for (const entry of patch.a.s ?? []) { const id = keyOf(entry); if (!byId.has(id)) added.push(id); byId.set(id, entry); }
  const ids = patch.a.r ?? order.filter(id => byId.has(id) && !added.includes(id)).concat(added);
  return ids.map(id => byId.get(id));
}

// ---- streams -------------------------------------------------------------------------------
function stream(name) {
  const gzip = createGzip();
  let compressed = 0, raw = 0, records = 0, keyframes = 0, max = 0;
  const sample = [], sampleBytes = { n: 0 };
  gzip.on('data', chunk => { compressed += chunk.length; });
  const done = new Promise(resolve => gzip.on('end', resolve));
  return {
    name,
    async write(text, keyframe) {
      const piece = (records ? ',' : '') + text;
      const bytes = Buffer.byteLength(piece);
      raw += bytes; records++; if (keyframe) keyframes++; max = Math.max(max, bytes);
      if (sampleBytes.n < SAMPLE_BYTES) { sample.push(piece); sampleBytes.n += bytes; }
      if (!gzip.write(piece)) await new Promise(resolve => gzip.once('drain', resolve));
    },
    async end() { gzip.end(); await done; return { name, raw, compressed, records, keyframes, maxRecordBytes: max, sample: sample.join('') }; },
  };
}
// Gzip + SHA-256 CPU per uncompressed MiB, from a sample of the stream (single thread, sync).
function throughput(text) {
  const buffer = Buffer.from(text);
  const cpu = process.cpuUsage(), start = performance.now();
  gzipSync(buffer); createHash('sha256').update(buffer).digest();
  const used = process.cpuUsage(cpu);
  return { sampleBytes: buffer.length, msPerMiB: (used.user + used.system) / 1000 / (buffer.length / 1048576), wallMs: performance.now() - start };
}

// ---- run -----------------------------------------------------------------------------------
const lock = await acquireMachineLock('bench', { mode: 'exclusive' });
const entry = structuredClone(cache.maps[0]);
if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
const match = await createMatch(cache.seed, liveZoneSize({ zoneWidth, zoneHeight }), entry.map, contentById(cache.content));

const full = stream('full');
const encodings = ['top', 'ent'], depthOf = { top: 1, ent: Infinity };
const variants = [];
for (const encoding of encodings) for (const cadence of cadences) variants.push({ encoding, cadence, out: stream(`${encoding}-k${cadence}`), keep: [] });
const shadows = {}, encodeMs = { top: [], ent: [] }, deltaBytes = { top: [], ent: [] };
const keyedPaths = new Set(), keyBytes = {};
let count = 0, fullDigest = createHash('sha256'), fullMax = 0, verified = 0, stringifyMs = [];
// Retain one archive per encoding at the middle cadence for reader measurements.
const kept = { cadence: cadences[Math.floor(cadences.length / 2)] };
try {
  do {
    const state = count ? match.advance() : match.snapshot();
    const t0 = performance.now();
    const line = JSON.stringify({ state, commands: [] });
    stringifyMs.push(performance.now() - t0);
    fullDigest.update(line + '\n'); fullMax = Math.max(fullMax, Buffer.byteLength(line));
    await full.write(line, true);
    for (const encoding of encodings) {
      const depth = depthOf[encoding];
      let text;
      const start = performance.now();
      const input = useKept && encoding === 'ent' ? stableLists(state) : state;
      if (!shadows[encoding]) shadows[encoding] = shadow(input, depth);
      else {
        const [next, patch] = diff(shadows[encoding], input, depth);
        shadows[encoding] = next;
        text = `{"tick":${state.tick},"delta":${patch ?? '{}'},"commands":[]}`;
      }
      encodeMs[encoding].push(performance.now() - start);
      if (text !== undefined) {
        deltaBytes[encoding].push(Buffer.byteLength(text));
        if (encoding === 'ent') for (const [key, patch] of Object.entries(JSON.parse(text).delta.o ?? {})) keyBytes[key] = (keyBytes[key] ?? 0) + JSON.stringify(patch).length;
      }
      for (const variant of variants) {
        if (variant.encoding !== encoding) continue;
        const keyframe = count % variant.cadence === 0;
        const record = keyframe ? line : text;
        await variant.out.write(record, keyframe);
        if (variant.cadence === kept.cadence) variant.keep.push(record);
      }
    }
    count++;
  } while (match.phase === 'live' && count <= maxTicks);
  for (const [name, s] of Object.entries(shadows)) if (s.kind === 'o') for (const [key, child] of Object.entries(s.children)) if (child.kind !== 'v') keyedPaths.add(`${name}:${key}:${child.kind}`);
} finally { var endTick = match.tick; match.dispose(); }

const fullResult = await full.end();
const fullCpu = throughput(fullResult.sample); delete fullResult.sample;
const results = [];
for (const variant of variants) {
  const r = await variant.out.end();
  r.cpu = throughput(r.sample); delete r.sample;
  r.ratio = { raw: r.raw / fullResult.raw, compressed: r.compressed / fullResult.compressed };
  results.push({ encoding: variant.encoding, cadence: variant.cadence, ...r });
}

// Reader: parse the retained archive, then reconstruct every frame forwards (playback) and
// at random ticks from the nearest keyframe (seek), checking exactness against the full lines.
async function readerStats(variant) {
  // A reader that loads the archive as one JSON document is limited by V8's longest string.
  const textBytes = variant.keep.reduce((sum, record) => sum + Buffer.byteLength(record) + 1, 1);
  if (textBytes >= MAX_STRING) return { textBytes, parseableAsOneString: false };
  const text = `[${variant.keep.join(',')}]`;
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let start = performance.now();
  const records = JSON.parse(text);
  const parseMs = performance.now() - start;
  if (global.gc) global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const keyIndex = [];
  records.forEach((record, i) => { if (record.state) keyIndex.push(i); });
  // Forward playback: one patch per tick.
  let state, applyMs = [];
  for (const record of records) {
    start = performance.now();
    state = record.state ?? apply(state, record.delta);
    applyMs.push(performance.now() - start);
  }
  // Random seeks: nearest keyframe at or before, then patches forward.
  let seed = 901;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const seekMs = [];
  for (let n = 0; n < 200; n++) {
    const target = Math.floor(random() * records.length);
    start = performance.now();
    let k = keyIndex[0];
    for (const i of keyIndex) { if (i <= target) k = i; else break; }
    let s = records[k].state;
    for (let i = k + 1; i <= target; i++) s = apply(s, records[i].delta);
    seekMs.push(performance.now() - start);
  }
  return { textBytes, parseableAsOneString: true, parseMs, heapMiB: (heapAfter - heapBefore) / 1048576, applyMs: summarize(applyMs), seekMs: summarize(seekMs), gcExposed: !!global.gc };
}
function summarize(list) {
  const sorted = [...list].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: list.length, mean: list.reduce((a, b) => a + b, 0) / Math.max(1, list.length), p50: at(0.5), p99: at(0.99), max: at(1) };
}
// Exactness: rebuild every frame of each retained archive and compare with a fresh full replay.
async function verify(variants) {
  const replay = structuredClone(cache.maps[0]);
  if (replay.navigation) attachPortalGraph(replay.map, replay.navigation);
  for (const packed of replay.tiles ?? []) adoptPackedTiles(replay.map, packed);
  const again = await createMatch(cache.seed, liveZoneSize({ zoneWidth, zoneHeight }), replay.map, contentById(cache.content));
  const states = variants.map(() => undefined), digests = variants.map(() => createHash('sha256'));
  const fresh = createHash('sha256');
  let i = 0, checked = 0;
  try {
    do {
      const state = i ? again.advance() : again.snapshot();
      const line = JSON.stringify({ state, commands: [] });
      fresh.update(line + '\n');
      variants.forEach((variant, v) => {
        const record = JSON.parse(variant.keep[i]);
        states[v] = record.state ?? apply(states[v], record.delta);
        const rebuilt = JSON.stringify({ state: states[v], commands: record.commands });
        digests[v].update(rebuilt + '\n');
        if (i % verifyEvery === 0 && rebuilt !== line) throw new Error(`${variant.encoding} frame ${i} differs`);
      });
      if (i % verifyEvery === 0) checked++;
      i++;
    } while (again.phase === 'live' && i < count);
  } finally { again.dispose(); }
  return { frames: i, checked, freshDigest: fresh.digest('hex'), rebuiltDigests: Object.fromEntries(variants.map((v, n) => [v.encoding, digests[n].digest('hex')])) };
}

const keptVariants = variants.filter(v => v.cadence === kept.cadence);
const readers = {};
for (const variant of keptVariants) readers[variant.encoding] = await readerStats(variant);
const verification = verifyEvery > 0 ? await verify(keptVariants) : null;
lock.release();

const result = {
  provenance: { kept: useKept, seed: cache.seed, size: cache.size, content: cache.content, node: process.version, frames: count, endTick, maxString: MAX_STRING },
  full: { ...fullResult, cpu: fullCpu, maxLineBytes: fullMax, digest: fullDigest.digest('hex'), stringifyMs: summarize(stringifyMs),
    parseableAsOneString: fullResult.raw < MAX_STRING },
  encode: Object.fromEntries(encodings.map(e => [e, { ms: summarize(encodeMs[e]), deltaBytes: summarize(deltaBytes[e]) }])),
  keyedPaths: [...keyedPaths],
  // Mean bytes per delta frame that each top-level key contributes to the `ent` encoding.
  entKeyBytes: Object.fromEntries(Object.entries(keyBytes).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / Math.max(1, count - 1))])),
  variants: results,
  reader: { cadence: kept.cadence, ...readers },
  verification,
};
if (verification) result.verification.matchesWriterDigest = Object.values(verification.rebuiltDigests).every(d => d === result.full.digest) && verification.freshDigest === result.full.digest;
if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
