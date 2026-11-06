// #842 diagnostic: real room lifecycle and paced host, with maps prepared by the
// production worker before timing. Reports preparation separately from tick 1.
// This short witness locates stalls; its percentiles are not capacity evidence.
// node tools/perf/room-startup.mjs --size=12x6 --out=test-results/startup.json
import { readFile, writeFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import { Session } from 'node:inspector/promises';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMapGenerator } from '../../server/map-generator.js';
import { createRoomService } from '../../server/room-service.js';
import { createReplayWriter } from '../../server/replay-writer.js';
import { startScheduler } from '../../server/scheduler.js';
import { liveZoneSize } from '../../map/live.ts';
import * as profiler from '../../shared/profiler.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { portalGraphOf, attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { defaultContent } from '../../shared/simulation/content.ts';

const args = cliArgs();
const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) throw new RangeError('unsupported --size');
const seed = Number(args.get('seed') ?? 4217);
const lock = await acquireMachineLock('bench');
const generator = createMapGenerator(), writers = [], phases = [], wakes = [], deliveries = [];
const errors = [];
const service = createRoomService({ devTools: 'all', reportError: error => errors.push(String(error)), replays: {
  start(header, options) {
    const writer = createReplayWriter({ header, ...options,
      output: new Writable({ write(_chunk, _encoding, done) { done(); } }), publish: async () => {} });
    writers.push(writer);
    return writer;
  }
} });
let stopScheduler, second;
const watch = (room, record = false) => {
  const peer = service.connect({ close() {}, deliver(payload) {
    if (record && payload.includes('"type":"state"')) deliveries.push(performance.now());
    return true;
  } });
  service.receive(peer, { type: 'join', room: room.id, role: 'dev', ownerKey: room.ownerKey });
  return peer;
};
// A timer due before each operation observes how long that operation prevents
// other callbacks from running, including promise continuations in preparation.
async function phase(name, operation) {
  const profile = args.has('profile') && name.startsWith('concurrent.');
  const inspector = profile ? new Session() : undefined;
  if (inspector) { inspector.connect(); await inspector.post('Profiler.enable'); await inspector.post('Profiler.start'); }
  const before = performance.now();
  const probe = sleep(0).then(() => performance.now() - before);
  await operation();
  const end = performance.now();
  phases.push({ name, atMs: before, operationMs: end - before, timerDelayMs: await probe });
  if (inspector) {
    const { profile } = await inspector.post('Profiler.stop');
    inspector.disconnect();
    await writeFile(`${args.get('profile')}-${name}.cpuprofile`, JSON.stringify(profile));
  }
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { samples: values.length, maxMs: at(1), p999Ms: at(0.999), over50: values.filter(v => v > 50).length };
};
try {
  // Same worker path as production, including navigation and tile adoption.
  let bundle;
  if (args.has('maps-cache')) {
    try { bundle = deserialize(await readFile(args.get('maps-cache'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (bundle && (bundle.seed !== seed || bundle.size !== `${zoneWidth}x${zoneHeight}` || bundle.content !== defaultContent().id))
      throw new Error('map cache seed/size/content mismatch; use a fresh cache path after code/content changes');
  }
  if (!bundle) {
    const maps = [await generator.generate(seed, size), await generator.generate(seed + 1, size)];
    bundle = { seed, size: `${zoneWidth}x${zoneHeight}`, content: defaultContent().id,
      maps: maps.map(map => ({ map, navigation: portalGraphOf(map), tiles: prebuiltTiles(map, defaultContent()) })) };
    if (args.has('maps-cache')) await writeFile(args.get('maps-cache'), serialize(bundle));
  }
  for (const { map, navigation, tiles } of bundle.maps) {
    if (navigation) attachPortalGraph(map, navigation);
    for (const packed of tiles) adoptPackedTiles(map, packed);
  }
  const [mapA, mapB] = bundle.maps.map(entry => entry.map);
  await generator.close();
  let first;
  await phase('cold.makeReady', async () => { first = service.makeRoom(seed, false, size, mapA); await first.ready; });
  let ownerA;
  await phase('cold.join', () => { ownerA = watch(first, true); });
  await phase('cold.start', () => service.receive(ownerA, { type: 'start' }));
  await phase('cold.tick1', () => service.advance(50, performance.now()));
  profiler.enable(true);
  deliveries.length = 0;
  stopScheduler = startScheduler((elapsed, now) => {
    const before = performance.now();
    service.advance(elapsed, now);
    wakes.push({ atMs: now, elapsedMs: elapsed, workMs: performance.now() - before, newRoomTick: second?.match?.tick ?? null });
  });
  // The first room is running before the second one's lifecycle begins.
  await sleep(1000);
  let prepared;
  await phase('concurrent.makeReady', async () => { prepared = service.makeRoom(seed + 1, false, size, mapB); await prepared.ready; });
  second = prepared;
  let ownerB;
  await phase('concurrent.join', () => { ownerB = watch(second); });
  await phase('concurrent.start', () => service.receive(ownerB, { type: 'start' }));
  await sleep(1500);
  stopScheduler();
  const gaps = deliveries.slice(1).map((v, i) => v - deliveries[i]);
  const result = { meta: { seed, size: args.get('size') ?? '12x6', node: process.version,
    recording: true, viewersPerRoom: 1, note: 'Short startup diagnostic; maps prebuilt, no sockets or disk. Not a capacity benchmark.' },
  phases, activeDeliveryGaps: { ...stats(gaps), over75: gaps.filter(v => v > 75).length }, wakes: stats(wakes.map(w => w.elapsedMs)),
  loopWork: stats(wakes.map(w => w.workMs)), stages: profiler.report(), raw: { wakes, gaps } };
  await service.close();
  result.recorderDrops = writers.map(w => w.droppedFrames);
  result.errors = errors;
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, stages: undefined, raw: undefined }, null, 2));
  if (errors.length || result.recorderDrops.some(Boolean)) throw new Error('unhealthy recording/lifecycle; inspect output');
} finally {
  stopScheduler?.();
  await service.close(); await generator.close(); profiler.enable(false); lock.release();
}
