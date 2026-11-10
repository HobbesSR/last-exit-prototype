// #842 diagnostic: real room lifecycle and paced host, with maps prepared by the
// production worker before timing. Reports preparation separately from tick 1.
// This short witness locates stalls; its percentiles are not capacity evidence.
// node tools/perf/room-startup.mjs --size=12x6 --out=test-results/startup.json
// Add --sockets --viewers=4 for worker-owned socket clients; --root=PATH selects
// alternate server modules while retaining this harness and its map preparation.
import { readFile, writeFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import { Session } from 'node:inspector/promises';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMapGenerator } from '../../server/map-generator.js';
import { startScheduler } from '../../server/scheduler.js';
import { liveZoneSize } from '../../map/live.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { portalGraphOf } from '../../shared/navigation/portal-graph.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { defaultContent } from '../../shared/simulation/content.ts';

const args = cliArgs();
const [zoneWidth, zoneHeight] = (args.get('size') ?? '12x6').split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) throw new RangeError('unsupported --size');
const seed = Number(args.get('seed') ?? 4217);
const viewers = Number(args.get('viewers') ?? 1), sockets = args.has('sockets');
if (!Number.isSafeInteger(viewers) || viewers < 1) throw new RangeError('--viewers must be a positive integer');
const root = resolve(args.get('root') ?? fileURLToPath(new URL('../../', import.meta.url)));
const serverModule = name => import(pathToFileURL(resolve(root, 'server', name)).href);
const { createRoomService } = await serverModule('room-service.js');
const { createReplayWriter } = await serverModule('replay-writer.js');
const { attachWebSockets } = sockets ? await serverModule('websocket.js') : {};
// WeakMap-backed navigation caches and profiling must come from the same module
// instances as the selected match, including when measuring archived sources.
const fromRoot = file => import(pathToFileURL(resolve(root, file)).href);
const profiler = await fromRoot('shared/profiler.ts');
const { attachPortalGraph } = await fromRoot('shared/navigation/portal-graph.ts');
const { adoptPackedTiles } = await fromRoot('shared/free-space.ts');
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
let stopScheduler, second, http, wss, clientWorker, socketUrl, closingClients = false;
let rpcId = 0, workerFailure;
const pending = new Map();
const rpc = (method, fields = {}) => new Promise((resolve, reject) => {
  if (workerFailure) return reject(workerFailure);
  const id = ++rpcId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`client RPC ${method} timed out`)); }, 35000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  clientWorker.postMessage({ id, method, ...fields });
});
async function openSockets() {
  http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  wss = attachWebSockets(http, service);
  wss.on('error', error => errors.push(String(error)));
  http.on('error', error => errors.push(String(error)));
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
  });
  socketUrl = `ws://127.0.0.1:${http.address().port}`;
  clientWorker = new Worker(new URL('./startup-client.mjs', import.meta.url));
  await new Promise((resolve, reject) => {
    const readyTimeout = setTimeout(() => fail(new Error('client worker startup timed out')), 30000);
    const fail = error => {
      clearTimeout(readyTimeout);
      workerFailure = error; errors.push(String(error)); reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    clientWorker.on('error', fail);
    clientWorker.on('exit', code => { if (!closingClients) fail(new Error(`client worker exited (${code})`)); });
    clientWorker.on('message', message => {
      if (message.event === 'ready') { clearTimeout(readyTimeout); resolve(); }
      else if (message.event === 'receipt') deliveries.push(message.atMs - performance.timeOrigin);
      else if (message.event === 'error') errors.push(message.error);
      else {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
      }
    });
  });
}
async function closeSockets() {
  const failures = [];
  if (clientWorker) {
    try { if (!workerFailure) await rpc('close'); }
    catch (error) { failures.push(error); }
    finally { closingClients = true; await clientWorker.terminate(); clientWorker = null; }
  }
  if (wss) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    wss = null;
  }
  if (http) {
    if (http.listening) await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    http = null;
  }
  if (failures.length) throw new AggregateError(failures, 'socket cleanup failed');
}
const watch = async (room, record = false) => {
  if (sockets) return rpc('join', { url: socketUrl, room: room.id, ownerKey: room.ownerKey, record });
  const peer = service.connect({ close() {}, deliver(payload) {
    if (record && payload.includes('"type":"state"')) deliveries.push(performance.now());
    return true;
  } });
  service.receive(peer, { type: 'join', room: room.id, role: 'dev', ownerKey: room.ownerKey });
  return peer;
};
async function joinViewers(room, record = false) {
  let owner;
  for (let i = 0; i < viewers; i++) {
    const peer = await watch(room, record && i === 0);
    owner ??= peer;
  }
  return owner;
}
const start = owner => sockets ? rpc('start', { clientId: owner }) : service.receive(owner, { type: 'start' });
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
  if (sockets) await openSockets();
  // Excludes generation/cache/adoption and socket/worker setup; includes service
  // close, replay drain and owned socket/client teardown. CPU is process-wide.
  const lifecycleStart = performance.now(), lifecycleCpu = process.cpuUsage();
  let first;
  await phase('cold.makeReady', async () => { first = service.makeRoom(seed, false, size, mapA); await first.ready; });
  let ownerA;
  await phase('cold.join', async () => { ownerA = await joinViewers(first, true); });
  await phase('cold.start', () => start(ownerA));
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
  await phase('concurrent.join', async () => { ownerB = await joinViewers(second); });
  await phase('concurrent.start', () => start(ownerB));
  await sleep(1500);
  stopScheduler();
  await service.close();
  await closeSockets();
  const cpu = process.cpuUsage(lifecycleCpu);
  const lifecycle = { wallMs: performance.now() - lifecycleStart,
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, cpuTotalMs: (cpu.user + cpu.system) / 1000,
    scope: 'After map preparation and transport setup through service close/replay drain and transport teardown',
    cpuScope: sockets ? 'Whole process, including socket client worker' : 'Whole process' };
  const gaps = deliveries.slice(1).map((v, i) => v - deliveries[i]);
  const result = { meta: { seed, size: args.get('size') ?? '12x6', node: process.version,
    recording: true, viewersPerRoom: viewers, sockets, serverRoot: root,
    deliveryObservation: sockets ? 'First active-room viewer state receipt after JSON parsing in client worker' : 'First active-room viewer direct fake-peer deliver callback',
    phaseCompletion: sockets ? 'Join waits for parsed welcome; start waits for first parsed state; tick1 measures host advance' : 'Direct room-service call completion',
    note: 'Short startup diagnostic; maps prebuilt, replay output discarded. Not a capacity benchmark.' },
  lifecycle, phases, activeDeliveryGaps: { ...stats(gaps), over75: gaps.filter(v => v > 75).length }, wakes: stats(wakes.map(w => w.elapsedMs)),
  loopWork: stats(wakes.map(w => w.workMs)), stages: profiler.report(), raw: { wakes, gaps, deliveryAtMs: deliveries } };
  result.recorderDrops = writers.map(w => w.droppedFrames);
  result.errors = errors;
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, stages: undefined, raw: undefined }, null, 2));
  if (errors.length || result.recorderDrops.some(Boolean)) throw new Error('unhealthy recording/lifecycle; inspect output');
} finally {
  stopScheduler?.();
  const cleanup = await Promise.allSettled([service.close(), generator.close(), closeSockets()]);
  profiler.enable(false); lock.release();
  for (const outcome of cleanup) if (outcome.status === 'rejected') console.error('startup cleanup failed:', outcome.reason);
}
