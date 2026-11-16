// #1093 design witness, isolated from the live protocol. Node CPU, not browser CPU.
// Requires a room-startup map cache; measures actual broadcast state messages.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createMatch } from '../../server/match.js';
import { broadcast, remember, viewEncoders } from '../../server/room-views.js';
import { liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { createCodec, collectKeys } from './wire-codec-prototype.mjs';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 120), stride = Number(args.get('stride') ?? 10);
const repeats = Number(args.get('repeats') ?? 3);
for (const n of [ticks, stride, repeats]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('positive integer options required');
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
const bytes = await readFile(args.get('maps-cache')), cache = deserialize(bytes);
const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size || !cache.maps?.length) throw new Error('unsupported map cache');
const hash = data => createHash('sha256').update(data).digest('hex');

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
const lock = await acquireMachineLock('bench', { mode: 'exclusive' });
let match;
try {
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));
  const corpus = [], room = { match, clients: new Set(), history: [], ...viewEncoders() };
  let at = 0;
  const add = (view, playerId, dev = false) => room.clients.add({ playerId, dev, deliver(payload) {
    if (at % stride === 0) corpus.push({ tick: at, view, message: JSON.parse(payload) });
    return true;
  } });
  const roster = match.snapshot().players;
  add('contestant', roster.find(p => p.role === 'contestant').id);
  add('gladiator', roster.find(p => p.role === 'gladiator').id);
  add('dev', undefined, true); add('spectator', undefined);
  for (at = 0; at <= ticks; at++) {
    const state = at ? match.advance() : match.snapshot();
    remember(room, state); broadcast(room, state);
    if (match.phase !== 'live') break;
  }
  const keys = new Set(); for (const row of corpus) collectKeys(row.message, keys);
  const dictionary = [...keys].sort(), codec = createCodec(dictionary);
  const modes = {
    json: { encode: JSON.stringify, decode: JSON.parse },
    binaryExact: codec,
    binaryQuantized: { encode: value => codec.encode(transform(value)), decode: value => transform(codec.decode(value), true) }
  };
  // Verify every sample, including optional presence and array order. Quantized fields have
  // the reference rounding bound by construction; remaining fields must rebuild exactly.
  for (const row of corpus) for (const [name, mode] of Object.entries(modes)) {
    const expected = name === 'binaryQuantized' ? transform(transform(row.message), true) : row.message;
    assert.deepEqual(mode.decode(mode.encode(row.message)), expected);
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
    // Warm all variants, then alternate forward/reverse order to reduce ordering bias.
    for (const mode of Object.values(modes)) for (const row of samples) mode.decode(mode.encode(row.message));
    for (let round = 0; round < repeats; round++) for (const name of (round % 2 ? Object.keys(modes).reverse() : Object.keys(modes))) {
      const mode = modes[name], inputs = samples.map(row => row.message), encoded = inputs.map(mode.encode);
      function timed(fn) {
        const cpu = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < inputs.length; i++) fn(i);
        const used = process.cpuUsage(cpu);
        return { wallMsPerFrame: (performance.now()-start)/inputs.length, cpuMsPerFrame: (used.user+used.system)/1000/inputs.length };
      }
      groups[view][name].rounds.push({ encode: timed(i => mode.encode(inputs[i])), decode: timed(i => mode.decode(encoded[i])) });
    }
  }
  const result = { issue: 1093, revision: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    harnessSha256: hash(await readFile(new URL(import.meta.url))), codecSha256: hash(await readFile(new URL('./wire-codec-prototype.mjs', import.meta.url))),
    date: new Date().toISOString(), node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
    cache: { path: args.get('maps-cache'), sha256: hash(bytes), size: cache.size, seed: cache.seed, content: cache.content, provenance: 'pre-existing room-startup cache; not freshly generated' },
    ticks, stride, repeats, corpusSha256: hash(JSON.stringify(corpus)), scales,
    dictionary, dictionaryBytes: Buffer.byteLength(JSON.stringify(dictionary)), groups, contention: lock.contention(),
    limits: ['Node reflective prototype, not generated codec or browser timing', 'dictionary learned from corpus, paid once out of band; no production schema',
      'encode/decode only, excludes projection, delta comparison, layer rebuild, network and rendering', 'short early-match sample; not capacity, loss, or prediction evidence',
      'welcomes/maps/control/input envelopes not measured; no bit packing, string interning or compression'] };
  await writeFile(args.get('out'), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify({ size: cache.size, samples: corpus.length, groups, contention: result.contention }, null, 2));
} finally { match?.dispose(); lock.release(); }
