// #1215: run each variant in a fresh process: node --expose-gc tools/runtime-map-room-measure.mjs current|flat [seed] [ticks]
import assert from 'node:assert/strict';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { LIVE_ZONE_SIZES, zoneSizeName } from '../map/live.ts';
import { createMapGenerator } from '../server/map-generator.js';
import { createMapPool, MAP_POOL_SIZE } from '../server/map-pool.js';
import { createRoomDirectory } from '../server/room-directory.js';
import { createRoomService } from '../server/room-service.js';
import { initCore } from '../shared/core.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const [variant, seedArg = '4217', ticksArg = '20'] = process.argv.slice(2);
const seed = Number(seedArg), ticks = Number(ticksArg);
assert.ok(['current', 'flat'].includes(variant) && Number.isSafeInteger(seed) && seed > 0 &&
  Number.isSafeInteger(ticks) && ticks > 0 && globalThis.gc,
'usage: node --expose-gc tools/runtime-map-room-measure.mjs current|flat [positive-seed] [positive-ticks]');
// Smoke mode is only a wiring check; it is not a production-stock measurement.
const smoke = process.env.RUNTIME_MAP_SMOKE === '1';
const size = smoke ? LIVE_ZONE_SIZES[0] : LIVE_ZONE_SIZES.find(s => zoneSizeName(s) === '36x18');
assert.ok(size, '36x18 must be a live size');
const sizes = smoke ? [size] : LIVE_ZONE_SIZES;
const progress = message => console.error(`[${variant}] ${message}`);
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

// Sum payloads, not JS object overhead. Count shared backing buffers once, and UTF-8 strings.
function payloadBytes(value, seen = new Set(), buffers = new Set()) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (buffers.has(value.buffer)) return 0;
    buffers.add(value.buffer); return value.buffer.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    if (buffers.has(value)) return 0;
    buffers.add(value); return value.byteLength;
  }
  return Object.values(value).reduce((n, child) => n + payloadBytes(child, seen, buffers), 0);
}
function memory(core, collect = true) {
  if (collect) globalThis.gc();
  const { rss, heapUsed, arrayBuffers, external } = process.memoryUsage();
  return { rss, maxRss: process.resourceUsage().maxRSS * 1024, heapUsed, arrayBuffers, external,
    wasmLinear: core.memory.buffer.byteLength };
}
const lock = await acquireMachineLock('bench');
let generator, pool, service;
try {
  const core = await initCore(), snapshots = { baseline: memory(core) }, generations = [];
  const stocked = new Map(sizes.map(s => [zoneSizeName(s), []]));
  let failure;
  generator = createMapGenerator({ runtimeMap: variant === 'flat' });
  progress(`filling the pool with ${MAP_POOL_SIZE} maps per size`);
  pool = createMapPool({ sizes, draw: () => seed, generate: async (drawn, mapSize) => {
    const sizeName = zoneSizeName(mapSize);
    progress(`generating ${sizeName} seed ${drawn}`);
    const start = performance.now();
    const map = await generator.generate(drawn, mapSize);
    const entry = { seed: drawn, size: sizeName, bytes: payloadBytes(map), ms: performance.now() - start };
    generations.push(entry); stocked.get(entry.size).push(entry);
    progress(`generated ${sizeName} in ${seconds(entry.ms)}`);
    return map;
  }, reportError: error => { failure = error; } });
  const stockSnapshot = () => ({ counts: pool.stock(), bytes: Object.fromEntries([...stocked].map(([k, entries]) => [k, entries.reduce((n, e) => n + e.bytes, 0)])) });
  const full = () => Object.values(pool.stock()).every(n => n === MAP_POOL_SIZE);
  async function waitFull() {
    const start = performance.now();
    while (!full()) { if (failure) throw failure; await sleep(100); }
    return performance.now() - start;
  }
  const initialStockMs = await waitFull();
  progress(`pool stocked in ${seconds(initialStockMs)}`);
  snapshots.stocked = memory(core);
  const initialStock = stockSnapshot();
  // A no-storage writer keeps the production recording path without filesystem noise.
  const replays = { start: () => ({ append() {}, finish: async () => ({}), abort() {}, discard() {} }) };
  service = createRoomService({ replays, reportError: error => { failure = error; } });
  const trackedPool = { take(s) {
    const taken = pool.take(s);
    if (taken) {
      const entry = stocked.get(zoneSizeName(s)).shift();
      assert.equal(entry.seed, taken.seed);
    }
    return taken;
  } };
  const directory = createRoomDirectory({ host: service, pool: trackedPool, generateMap: generator.generate });
  const rooms = [];
  for (let i = 0; i < 2; i++) {
    let start = performance.now();
    const descriptor = directory.createRoom(undefined, false, size);
    assert.ok(descriptor);
    const createMs = performance.now() - start;
    const stockAfterTake = stockSnapshot();
    start = performance.now();
    await descriptor.ready;
    if (failure) throw failure;
    const readyMs = performance.now() - start;
    const session = service.connect({ deliver: () => true, close() {} });
    service.receive(session, { type: 'join', room: descriptor.id, ownerKey: descriptor.ownerKey });
    assert.equal(session.roomId, descriptor.id);
    start = performance.now();
    service.receive(session, { type: 'start' });
    assert.equal(service.summaries().find(r => r.id === descriptor.id)?.phase, 'live');
    const startMs = performance.now() - start;
    let room = service.rooms.get(descriptor.id);
    const beforeTick = room.game.tick;
    start = performance.now();
    for (let t = 0; t < ticks; t++) service.advance(50, (t + 1) * 50);
    const tickMs = performance.now() - start, advanced = room.game.tick - beforeTick;
    assert.equal(advanced, ticks);
    const live = memory(core);
    progress(`room ${i + 1} opened and ran ${advanced} ticks, waiting for its pool refill`);
    service.disconnect(session);
    room.onDispose();
    room = null;
    const disposed = memory(core);
    const refillMs = await waitFull();
    progress(`room ${i + 1} retired and pool refilled in ${seconds(refillMs)}`);
    const refilled = memory(core);
    rooms.push({ seed: descriptor.seed, createMs, readyMs, startMs, ticks: advanced, tickMs,
      stockAfterTake, live, disposed, refillMs, stockAfterRefill: stockSnapshot(), refilled });
  }
  console.log(JSON.stringify({ variant, seed, content: defaultContent().id, node: process.version,
    cpu: os.cpus()[0].model, smoke, size: zoneSizeName(size), poolDepth: MAP_POOL_SIZE, initialStockMs,
    initialStock, snapshots, generations, rooms, contention: lock.contention() }));
} finally {
  pool?.close();
  await service?.close();
  await generator?.close();
  lock.release();
}
