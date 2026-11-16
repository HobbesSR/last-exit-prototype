// #1089 acceptance: does a second room's preparation and start disturb a room already running?
// Real sockets, a real file archive (so each room's recorder runs), real time and the production map
// handoff: maps come packed from the map worker and the host hands them to the room as it would a pooled
// or generated one, so a threaded room decodes its map on its own thread. One pair: room A runs with a
// recording dev viewer; its delivery gaps are measured over a steady window, then over a startup window
// from room B's creation until 1.5 s after B's first state frame. CPU is process-wide (every thread,
// including the socket clients' worker) beside wall time, per window. Recorder health is each archive's
// own report of dropped frames, read after close. Pairs run sequentially, under the machine lock.
//   node tools/perf/room-isolation.mjs --size=36x18 --host=threads --pairs=3 --maps-cache=test-results/iso-36.bin --out=test-results/iso-36-threads.json
// --host=inline runs both rooms on the host thread (the pre-#1089 shape) for the comparison.
// --profile (threads only, #1119) turns profiling on and reads each room thread's own series (#1115) per
// window: preparation (to ready), tick 1 (from just before start until the room has simulated a tick), the
// early window (A: the settle period; B: the tail), and A's steady and startup windows. A thread's series are
// reset between windows, so each window's maxima are its own. Profiling adds work, so isolation figures
// should come from a run without it.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMapGenerator } from '../../server/map-generator.js';
import { createFileReplayStore } from '../../server/replay-store.js';
import { createRoomService } from '../../server/room-service.js';
import { attachWebSockets } from '../../server/websocket.js';
import { startScheduler } from '../../server/scheduler.js';
import { liveZoneSize } from '../../map/live.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';

const args = cliArgs();
const sizeName = args.get('size') ?? '12x6';
const [zoneWidth, zoneHeight] = sizeName.split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) throw new RangeError('unsupported --size');
const host = args.get('host') ?? 'threads';
if (!['threads', 'inline'].includes(host)) throw new RangeError('--host is threads or inline');
const seed = Number(args.get('seed') ?? 4217), pairs = Number(args.get('pairs') ?? 3);
const steadyMs = Number(args.get('steady-ms') ?? 3000), settleMs = Number(args.get('settle-ms') ?? 2000), tailMs = 1500;
const profile = args.has('profile');
if (profile && host !== 'threads') throw new RangeError('--profile reads room threads; use --host=threads');

// A packed map is consumed by its transfer, so each room is given its own copy of the bytes.
const copyPacked = packed => structuredClone(packed);

async function loadMaps() {
  const cachePath = args.get('maps-cache');
  if (cachePath) {
    try {
      const bundle = deserialize(await readFile(cachePath));
      if (bundle.seed !== seed || bundle.size !== sizeName || bundle.content !== defaultContent().id)
        throw new Error('map cache seed/size/content mismatch; use a fresh cache path after code/content changes');
      return bundle.maps;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const generator = createMapGenerator();
  try {
    const maps = [await generator.generate(seed, size), await generator.generate(seed + 1, size)];
    if (cachePath) await writeFile(cachePath, serialize({ seed, size: sizeName, content: defaultContent().id, maps }));
    return maps;
  } finally { await generator.close(); }
}

function clientWorker() {
  const worker = new Worker(new URL('./startup-client.mjs', import.meta.url));
  const pending = new Map(), receipts = [], errors = [];
  let next = 0, closing = false;
  const ready = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', code => { if (!closing) errors.push(`client worker exited (${code})`); });
    worker.on('message', message => {
      if (message.event === 'ready') resolve();
      else if (message.event === 'receipt') receipts.push(message.atMs - performance.timeOrigin);
      else if (message.event === 'error') errors.push(message.error);
      else {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
      }
    });
  });
  const rpc = (method, fields = {}) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, ...fields });
  });
  return { ready, rpc, receipts, errors, async close() { try { await rpc('close'); } finally { closing = true; await worker.terminate(); } } };
}

const gapsOf = (times, from, to) => {
  const inside = times.filter(t => t >= from && t <= to);
  return inside.slice(1).map((t, i) => t - inside[i]);
};
const stats = gaps => {
  const sorted = [...gaps].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { samples: gaps.length, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1), over75: gaps.filter(g => g > 75).length };
};
const cpuMs = usage => (usage.user + usage.system) / 1000;

// One room thread's series for a window, then cleared so the next window starts empty (enable(false) resets).
async function takeWindow(room) {
  const answer = await room.profile(5000);
  if (!answer) throw new Error(`room ${room.id} did not answer its profile request`);
  room.setProfiling(false); room.setProfiling(true);
  return answer;
}
const row = (answer, name) => answer.series.find(r => r.name === name);
// The few figures a reader compares; the full rows stay in the --out file.
function condense(answer) {
  const out = { frames: answer.frames }, steps = row(answer, 'loop.simSteps');
  if (steps) out.simSteps = Math.round(steps.mean * steps.samples);
  for (const name of ['loop.tick', 'sim.solve', 'loop.record', 'loop.broadcast']) {
    const r = row(answer, name);
    if (r) out[name] = { maxMs: r.max, meanMs: r.mean };
  }
  const wake = row(answer, 'loop.wake');
  if (wake) out['loop.wake'] = { maxMs: wake.max };
  const prepare = answer.series.filter(r => r.name.startsWith('prepare.'));
  if (prepare.length) out.prepare = Object.fromEntries(prepare.map(r => [r.name, r.mean * r.calls]));
  return out;
}
// Tick 1's window ends once the thread has simulated a tick; a slow tick 1 may be followed by a catch-up
// tick before the answer, which `simSteps` shows.
async function tickOneWindow(room) {
  for (const deadline = performance.now() + 10000; performance.now() < deadline; await sleep(10)) {
    const answer = await room.profile(5000);
    const steps = answer && row(answer, 'loop.simSteps');
    if (steps && steps.mean * steps.samples >= 1) return takeWindow(room);
  }
  throw new Error(`room ${room.id} simulated no tick within 10 s of starting`);
}

async function runPair(index, [mapA, mapB]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'room-isolation-'));
  const replays = await createFileReplayStore(dir), errors = [];
  const service = createRoomService({ replays, devTools: 'all', threads: host === 'threads', reportError: error => errors.push(String(error)) });
  if (profile) service.setProfiling(true);
  const profiles = { A: {}, B: {} }, thread = descriptor => service.rooms.get(descriptor.id);
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = attachWebSockets(http, service);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${http.address().port}`;
  const stopScheduler = startScheduler(service.advance), clients = clientWorker();
  try {
    await clients.ready;
    const aFrom = performance.now(), aCpu = process.cpuUsage();
    const a = service.makeRoom(seed, false, size, copyPacked(mapA));
    await a.ready;
    const aReady = { readyMs: performance.now() - aFrom, cpuMs: cpuMs(process.cpuUsage(aCpu)) };
    if (profile) profiles.A.prepare = await takeWindow(thread(a));
    const viewerA = await clients.rpc('join', { url, room: a.id, ownerKey: a.ownerKey, record: true });
    if (profile) await takeWindow(thread(a));
    await clients.rpc('start', { clientId: viewerA });
    if (profile) profiles.A.tick1 = await tickOneWindow(thread(a));
    await sleep(settleMs);
    if (profile) profiles.A.early = await takeWindow(thread(a));
    const steadyFrom = performance.now(), steadyCpu = process.cpuUsage();
    await sleep(steadyMs);
    const steadyTo = performance.now(), steady = { wallMs: steadyTo - steadyFrom, cpuMs: cpuMs(process.cpuUsage(steadyCpu)) };
    if (profile) profiles.A.steady = await takeWindow(thread(a));
    const startFrom = performance.now(), startCpu = process.cpuUsage();
    const b = service.makeRoom(seed + 1, false, size, copyPacked(mapB));
    await b.ready;
    const readyMs = performance.now() - startFrom;
    if (profile) profiles.B.prepare = await takeWindow(thread(b));
    const viewerB = await clients.rpc('join', { url, room: b.id, ownerKey: b.ownerKey, record: false });
    if (profile) await takeWindow(thread(b));
    await clients.rpc('start', { clientId: viewerB });
    const firstStateMs = performance.now() - startFrom;
    if (profile) profiles.B.tick1 = await tickOneWindow(thread(b));
    await sleep(tailMs);
    const startTo = performance.now(), startup = { wallMs: startTo - startFrom, cpuMs: cpuMs(process.cpuUsage(startCpu)), readyMs, firstStateMs };
    if (profile) [profiles.A.duringB, profiles.B.early] = await Promise.all([takeWindow(thread(a)), takeWindow(thread(b))]);
    stopScheduler();
    await service.close();
    await clients.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => http.close(resolve));
    const metas = await Promise.all((await readdir(dir)).filter(f => f.endsWith('.meta.json')).map(async f => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    const recorder = metas.map(meta => ({ room: meta.id === a.id ? 'A' : 'B', frames: meta.frames, droppedFrames: meta.recording?.droppedFrames ?? 0 }));
    return {
      pair: index, aReady,
      ...(profile ? { profiles: Object.fromEntries(Object.entries(profiles).map(([room, windows]) =>
        [room, Object.fromEntries(Object.entries(windows).map(([name, answer]) => [name, { summary: condense(answer), series: answer.series }]))])) } : {}),
      steady: { ...steady, gaps: stats(gapsOf(clients.receipts, steadyFrom, steadyTo)) },
      startup: { ...startup, gaps: stats(gapsOf(clients.receipts, startFrom, startTo)) },
      recorder, errors: [...errors, ...clients.errors],
    };
  } finally {
    stopScheduler();
    await service.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

const maps = await loadMaps();
const lock = await acquireMachineLock('bench');
try {
  const results = [];
  for (let i = 0; i < pairs; i++) results.push(await runPair(i, maps));
  const result = { meta: { size: sizeName, host, seed, pairs, steadyMs, settleMs, tailMs, profile, node: process.version,
    delivery: 'Room A dev viewer state receipts, parsed in a socket client worker',
    cpu: 'process.cpuUsage over the window: every thread, including the socket client worker' },
  contention: lock.contention(), results };
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  // The full per-window series go to --out only.
  console.log(JSON.stringify({ ...result, results: results.map(r => r.profiles ? { ...r, profiles: Object.fromEntries(Object.entries(r.profiles)
    .map(([room, windows]) => [room, Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, w.summary]))])) } : r) }, null, 2));
  if (results.some(r => r.errors.length || r.recorder.some(x => x.droppedFrames))) process.exitCode = 1;
} finally { lock.release(); }
