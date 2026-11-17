// #1093 design witness, isolated from the live protocol. Node CPU, not browser CPU.
// Requires a room-startup map cache; measures actual broadcast state messages.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createMatch } from '../../server/match.js';
import { createMapGenerator } from '../../server/map-generator.js';
import { broadcast, remember, spectatorFrame, viewEncoders } from '../../server/room-views.js';
import { createLayerDecoder } from '../../shared/frame-layers.ts';
import { createDiscoveryDecoder } from '../../shared/discovery.ts';
import { liveZoneSize } from '../../map/live.ts';
import { contentById, CONTENT_ID } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { createCodec, collectKeys } from './wire-codec-prototype.mjs';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), stride = Number(args.get('stride') ?? 20);
const repeats = Number(args.get('repeats') ?? 3);
for (const n of [ticks, stride, repeats]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('positive integer options required');
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
const hash = data => createHash('sha256').update(data).digest('hex');
const revision = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();

// Only explicit projected record fields; shapes, motor, inventory and private state stay exact.
// Signed integers are a prototype transport representation, not clamped fixed-width values.
const scales = { players: { x: 256, y: 256, heading: 65536 / (2 * Math.PI) },
  items: { x: 256, y: 256 }, traps: { x: 256, y: 256, homeX: 256, homeY: 256, heading: 65536 / (2 * Math.PI) },
  projectiles: { x: 256, y: 256, dx: 256, dy: 256 }, effects: { x: 256, y: 256 },
  bodies: { x: 256, y: 256, vx: 256, vy: 256, angle: 65536 / (2 * Math.PI), omega: 4096 },
  hookFlights: { x: 256, y: 256 } };
function transform(message, inverse = false) {
  const state = { ...message.state };
  for (const [family, fields] of Object.entries(scales)) {
    const entry = value => {
      const copy = { ...value };
      for (const [key, scale] of Object.entries(fields)) if (typeof copy[key] === 'number') {
        const n = inverse ? copy[key] / scale : Math.round(copy[key] * scale);
        if (!Number.isFinite(n) || (!inverse && !Number.isSafeInteger(n))) throw new Error(`quantization overflow ${family}.${key}`);
        copy[key] = n === 0 ? 0 : n;
      }
      return copy;
    };
    const value = state[family];
    if (Array.isArray(value)) state[family] = value.map(entry);
    else if (value) {
      state[family] = { ...value };
      for (const key of ['all', 'set']) if (value[key]) state[family][key] = value[key].map(entry);
    }
  }
  return { ...message, state };
}
const lock = await acquireMachineLock('bench', { mode: args.has('timing') ? 'exclusive' : 'shared' });
let match;
try {
  if (args.has('generate')) {
    // Tool changes are fine; generation/runtime source must have a committed identity.
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'map', 'shared', 'server']);
    const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
    const size = liveZoneSize({ zoneWidth, zoneHeight });
    if (!size) throw new Error('unsupported --size');
    const generator = createMapGenerator();
    try {
      const seed = Number(args.get('seed') ?? 4217), packed = await generator.generate(seed, size);
      const entry = { ...deserialize(packed.bytes), tiles: packed.tiles };
      await writeFile(args.get('maps-cache'), serialize({ seed, size: `${zoneWidth}x${zoneHeight}`, content: CONTENT_ID,
        source: revision, generatedAt: new Date().toISOString(), generator: entry.map.generator, maps: [entry] }), { flag: 'wx' });
    } finally { await generator.close(); }
  }
  const bytes = await readFile(args.get('maps-cache')), cache = deserialize(bytes);
  const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
  if (!size || !cache.maps?.length || cache.content !== CONTENT_ID) throw new Error('unsupported map cache');
  if (cache.generator !== 'chain-live-2') throw new Error('requires a freshly generated tuned-loot cache');
  if (!cache.source) throw new Error('cache source revision required');
  execFileSync('git', ['diff', '--exit-code', cache.source, '--', 'map', 'shared', 'server']);
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));
  const corpus = [], room = { match, clients: new Set(), history: [], ...viewEncoders() };
  let at = 0, current, deliveriesVerified = 0, actualTicks = 0;
  const streamDigest = createHash('sha256'), population = {};
  const add = (view, playerId, dev = false) => {
    const layers = createLayerDecoder(), discovery = createDiscoveryDecoder();
    room.clients.add({ playerId, dev, stateEncoding: 'json', deliver(payload) {
      const message = JSON.parse(payload), rebuilt = layers.decode(JSON.parse(payload).state);
      const expected = match.project(view === 'spectator' ? spectatorFrame(room) : current, playerId);
      const me = rebuilt.players?.find(p => p.id === playerId);
      if (me?.discovered) me.discovered = [...discovery.decode(me.discovered)];
      assert.deepEqual(rebuilt, JSON.parse(JSON.stringify(expected)), `${view} layered reconstruction tick ${at}`);
      streamDigest.update(view + payload); deliveriesVerified++;
      for (const key of ['players', 'items', 'bodies', 'traps', 'projectiles', 'effects', 'tethers', 'hookFlights']) {
        population[view] ??= {};
        population[view][key] = Math.max(population[view][key] ?? 0, expected[key]?.length ?? 0);
      }
      if (at % stride === 0) corpus.push({ tick: at, view, message });
      return true;
    } });
  };
  const roster = match.snapshot().players;
  add('contestant', roster.find(p => p.role === 'contestant').id);
  add('gladiator', roster.find(p => p.role === 'gladiator').id);
  add('dev', undefined, true); add('spectator', undefined);
  for (at = 0; at <= ticks; at++) {
    current = at ? match.advance() : match.snapshot(); actualTicks = current.tick;
    remember(room, current); broadcast(room, current);
    if (match.phase !== 'live') break;
  }
  const keys = new Set(); for (const row of corpus) collectKeys(row.message, keys);
  const dictionary = [...keys].sort(), codec = createCodec(dictionary);
  const modes = {
    json: { encode: JSON.stringify, decode: JSON.parse },
    binaryExact: codec,
    binaryQuantized: { encode: value => codec.encode(transform(value)), decode: value => transform(codec.decode(value), true) }
  };
  const quantization = {};
  // Verify every sample, including optional presence and array order. Quantized fields have
  // the reference rounding bound by construction; remaining fields must rebuild exactly.
  for (const row of corpus) for (const [name, mode] of Object.entries(modes)) {
    const expected = name === 'binaryQuantized' ? transform(transform(row.message), true) : row.message;
    assert.deepEqual(mode.decode(mode.encode(row.message)), expected);
    if (name === 'binaryQuantized') for (const [family, fields] of Object.entries(scales)) {
      const original = row.message.state[family], rounded = expected.state[family];
      const lists = Array.isArray(original) ? [[original, rounded]] : ['all','set'].filter(k => original?.[k]).map(k => [original[k], rounded[k]]);
      for (const [before, after] of lists) for (let i = 0; i < before.length; i++) for (const [field, scale] of Object.entries(fields)) {
        const value = before[i][field]; if (typeof value !== 'number') continue;
        const error = Math.abs(value - after[i][field]), bound = 0.5 / scale;
        assert.ok(error <= bound + Math.abs(value) * Number.EPSILON * 2, `${family}.${field} rounding bound`);
        const stats = quantization[`${family}.${field}`] ??= { count: 0, maxError: 0, bound, maxMagnitude: 0 };
        stats.count++; stats.maxError = Math.max(stats.maxError, error); stats.maxMagnitude = Math.max(stats.maxMagnitude, Math.abs(value));
      }
    }
  }
  const groups = {};
  for (const view of ['contestant', 'gladiator', 'dev', 'spectator']) {
    groups[view] = {};
    const samples = corpus.filter(row => row.view === view);
    for (const [name, mode] of Object.entries(modes)) {
      const encoded = samples.map(row => mode.encode(row.message));
      const sizes = encoded.map(value => typeof value === 'string' ? Buffer.byteLength(value) : value.length);
      groups[view][name] = { samples: sizes.length, firstBytes: sizes[0], meanBytes: sizes.reduce((a,b) => a+b,0)/sizes.length,
        steadyMeanBytes: sizes.slice(1).reduce((a,b)=>a+b,0) / Math.max(1,sizes.length-1), maxBytes: Math.max(...sizes), rounds: [] };
    }
    if (!args.has('timing')) continue;
    // Warm all variants, then alternate forward/reverse order to reduce ordering bias.
    for (const mode of Object.values(modes)) for (const row of samples) mode.decode(mode.encode(row.message));
    for (let round = 0; round < repeats; round++) for (const name of (round % 2 ? Object.keys(modes).reverse() : Object.keys(modes))) {
      const mode = modes[name], inputs = samples.map(row => row.message), encoded = inputs.map(mode.encode);
      function timed(fn) {
        const cpu = process.cpuUsage(), start = performance.now();
        let count = 0;
        do { for (let i = 0; i < inputs.length; i++) { fn(i); count++; } } while (performance.now()-start < 200);
        const used = process.cpuUsage(cpu);
        return { iterations: count, wallMsPerFrame: (performance.now()-start)/count, cpuMsPerFrame: (used.user+used.system)/1000/count };
      }
      groups[view][name].rounds.push({ encode: timed(i => mode.encode(inputs[i])), decode: timed(i => mode.decode(encoded[i])) });
    }
  }
  const result = { issue: 1093, revision, timing: args.has('timing'),
    harnessSha256: hash(await readFile(new URL(import.meta.url))), codecSha256: hash(await readFile(new URL('./wire-codec-prototype.mjs', import.meta.url))),
    date: new Date().toISOString(), node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
    cache: { path: args.get('maps-cache'), sha256: hash(bytes), size: cache.size, seed: cache.seed, content: cache.content,
      source: cache.source, generatedAt: cache.generatedAt, generator: cache.generator },
    ticks, actualTicks, stride, repeats, corpusSha256: hash(JSON.stringify(corpus)), streamSha256: streamDigest.digest('hex'), deliveriesVerified, population, scales, quantization,
    dictionary, dictionaryBytes: Buffer.byteLength(JSON.stringify(dictionary)), groups, contention: lock.contention(),
    limits: ['Node reflective prototype, not generated codec or browser timing', 'dictionary learned from corpus, paid once out of band; no production schema',
      'encode/decode only, excludes projection, delta comparison, layer rebuild, network and rendering', 'first simulated minute; not capacity, loss, or prediction evidence',
      'views follow bot-controlled actors, not human input/prediction traces', 'sampled messages are not independently replayable; full JSON layer stream verified before sampling',
      'quantization happens after production layer comparison; changes and keyframe cadence are unchanged',
      'welcomes/maps/control/input envelopes not measured; no bit packing, string interning or compression'] };
  await writeFile(args.get('out'), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify({ size: cache.size, samples: corpus.length, out: args.get('out'), contention: result.contention }));
} finally { match?.dispose(); lock.release(); }
