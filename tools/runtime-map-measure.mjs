// #1215 spike. Run one seed and size per process with node --expose-gc.
import assert from 'node:assert/strict';
import os from 'node:os';
import { generateLiveMap, LIVE_ZONE_SIZES, zoneSizeName } from '../map/live.ts';
import { packMap, unpackMap } from '../server/map-pack.js';
import { initCore } from '../shared/core.ts';
import { discoveryGrid } from '../shared/discovery.ts';
import { packTiles } from '../shared/free-space.ts';
import { contestantKnowledge, createKnowledgePlanner, freeTilesFor } from '../shared/navigation/knowledge.ts';
import { packRuntimeNavigation } from '../server/runtime-map-write.js';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { legGoal } from '../shared/simulation/bot-routes.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const [, , sizeName, seedArg, compactArg] = process.argv;
const size = LIVE_ZONE_SIZES.find(candidate => zoneSizeName(candidate) === sizeName);
const seed = Number(seedArg);
const measureCompact = compactArg === '--compact';
assert.ok(size && Number.isSafeInteger(seed) && seed > 0 && globalThis.gc && (compactArg === undefined || measureCompact),
  'usage: node --expose-gc tools/runtime-map-measure.mjs <live-size> <seed> [--compact]');

function memory(core, collect = false) {
  if (collect) globalThis.gc();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  return { heapUsed, arrayBuffers, rss, peakRss: process.resourceUsage().maxRSS * 1024,
    wasmLinear: core.memory.buffer.byteLength };
}

function tileBytes({ index, floats, ints, gates }) {
  return index.byteLength + floats.byteLength + ints.byteLength + Buffer.byteLength(gates);
}

function coordinateSample(layers) {
  const byRole = {};
  for (const [i, { tiles }] of layers.entries()) {
    let count = 0, f32Mismatches = 0, maxF32Error = 0;
    for (const { points } of tiles) for (const point of points) {
      count++;
      const f32 = Math.fround(point);
      if (!Object.is(point, f32)) f32Mismatches++;
      maxF32Error = Math.max(maxF32Error, Math.abs(point - f32));
    }
    byRole[i === 0 ? 'gladiator' : 'contestant'] = { count, f32Mismatches, maxF32Error };
  }
  return byRole;
}

async function firstPlans(envelope, layers, content) {
  const game = await createGame(seed, unpackMap({ ...envelope, tiles: layers }), content);
  try {
    const results = {};
    for (const role of ['gladiator', 'contestant']) {
      const bot = game.players.find(player => player.role === role);
      const planner = createKnowledgePlanner(game.map, role);
      const knowledge = role === 'contestant' ? contestantKnowledge(bot.discovery, bot.keys) : {
        known: () => true, keys: bot.keys, revision: 0,
        door: id => game.map.gates.find(gate => gate.id === id),
      };
      const start = performance.now();
      const goal = role === 'gladiator' ? legGoal(game, bot, game.map.exit) : game.map.exit;
      const route = planner.route(knowledge, bot, goal);
      results[role] = { ms: performance.now() - start, route };
    }
    return results;
  } finally {
    disposePhysics(game);
  }
}

const lock = await acquireMachineLock('bench');
try {
  const content = defaultContent(), core = await initCore(), sample = lock.contention;
  const ms = {}, snapshots = { baseline: memory(core, true) };
  let started = performance.now();
  let map = generateLiveMap(seed, content, size);
  ms.map = performance.now() - started;
  snapshots.map = memory(core);
  const { cols, rows } = discoveryGrid(map);
  const layers = [], builtLayers = [];
  for (const role of ['gladiator', 'contestant']) {
    started = performance.now();
    const { tiles, clearance, size: cellSize } = freeTilesFor(map, role);
    builtLayers.push({ tiles, clearance, size: cellSize, cols });
    ms[`${role}Build`] = performance.now() - started;
    started = performance.now();
    layers.push(packTiles(tiles, clearance, cellSize, cols));
    ms[`${role}Pack`] = performance.now() - started;
    snapshots[role] = memory(core);
  }
  started = performance.now();
  const envelope = packMap(map, layers);
  ms.workerEnvelope = performance.now() - started;
  started = performance.now();
  let navigation = packRuntimeNavigation(map, builtLayers);
  ms.flatNavigation = performance.now() - started;
  const coordinates = coordinateSample(builtLayers);
  const bytes = { workerMap: envelope.bytes.byteLength, workerGladiator: tileBytes(layers[0]),
    workerContestant: tileBytes(layers[1]), flatNavigation: navigation.byteLength };
  // Opt in because the extra pack affects peak RSS and the timing of later phases.
  if (measureCompact) bytes.compactNavigation = packRuntimeNavigation(map, builtLayers, { compact: true }).byteLength;
  builtLayers.length = 0;
  snapshots.builder = memory(core, true);
  map = null;
  snapshots.queued = memory(core, true);
  // Exercise the real allocator and copy. With lazy views the allocation itself is the retained
  // payload. Rust decoding and search are outside this measurement spike.
  started = performance.now();
  const ptr = core.core_alloc(bytes.flatNavigation) >>> 0;
  assert.ok(ptr);
  new Uint8Array(core.memory.buffer, ptr, bytes.flatNavigation).set(navigation);
  ms.wasmCopy = performance.now() - started;
  snapshots.overlap = memory(core);
  navigation = null;
  // An unpacked room keeps the map and its two packed layers. Drop the worker's serialized map
  // bytes and simulated upload staging, and measure with the WASM payload still owned by the core.
  started = performance.now();
  let roomMap = unpackMap(envelope);
  ms.workerUnpack = performance.now() - started;
  envelope.bytes = null;
  snapshots.retained = memory(core, true);
  core.core_free(ptr, bytes.flatNavigation);

  const coldEnvelope = packMap(roomMap);
  roomMap = null;
  const plans = {};
  for (const variant of seed % 2 ? ['current', 'both'] : ['both', 'current']) {
    globalThis.gc();
    plans[variant] = await firstPlans(coldEnvelope, variant === 'both' ? layers : layers.slice(0, 1), content);
  }
  for (const role of ['gladiator', 'contestant']) {
    const route = plans.both[role].route;
    assert.deepEqual(plans.current[role].route, route);
    const summary = { status: route.status, tiles: route.tiles, expansions: route.expansions };
    plans.current[role].route = summary;
    plans.both[role].route = summary;
  }
  console.log(JSON.stringify({ node: process.version, cpu: os.cpus()[0].model, content: content.id,
    size: sizeName, seed, grid: { cols, rows }, ms, bytes, coordinates, snapshots, plans, contention: sample() }));
} finally {
  lock.release();
}
