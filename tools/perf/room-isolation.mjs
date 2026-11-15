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

async function runPair(index, [mapA, mapB]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'room-isolation-'));
  const replays = await createFileReplayStore(dir), errors = [];
  const service = createRoomService({ replays, devTools: 'all', threads: host === 'threads', reportError: error => errors.push(String(error)) });
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = attachWebSockets(http, service);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${http.address().port}`;
  const stopScheduler = startScheduler(service.advance), clients = clientWorker();
  try {
    await clients.ready;
    const a = service.makeRoom(seed, false, size, copyPacked(mapA));
    await a.ready;
    const viewerA = await clients.rpc('join', { url, room: a.id, ownerKey: a.ownerKey, record: true });
    await clients.rpc('start', { clientId: viewerA });
    await sleep(settleMs);
    const steadyFrom = performance.now(), steadyCpu = process.cpuUsage();
    await sleep(steadyMs);
    const steadyTo = performance.now(), steady = { wallMs: steadyTo - steadyFrom, cpuMs: cpuMs(process.cpuUsage(steadyCpu)) };
    const startFrom = performance.now(), startCpu = process.cpuUsage();
    const b = service.makeRoom(seed + 1, false, size, copyPacked(mapB));
    await b.ready;
    const readyMs = performance.now() - startFrom;
    const viewerB = await clients.rpc('join', { url, room: b.id, ownerKey: b.ownerKey, record: false });
    await clients.rpc('start', { clientId: viewerB });
    const firstStateMs = performance.now() - startFrom;
    await sleep(tailMs);
    const startTo = performance.now(), startup = { wallMs: startTo - startFrom, cpuMs: cpuMs(process.cpuUsage(startCpu)), readyMs, firstStateMs };
    stopScheduler();
    await service.close();
    await clients.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => http.close(resolve));
    const metas = await Promise.all((await readdir(dir)).filter(f => f.endsWith('.meta.json')).map(async f => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    const recorder = metas.map(meta => ({ room: meta.id === a.id ? 'A' : 'B', frames: meta.frames, droppedFrames: meta.recording?.droppedFrames ?? 0 }));
    return {
      pair: index,
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
  const result = { meta: { size: sizeName, host, seed, pairs, steadyMs, settleMs, tailMs, node: process.version,
    delivery: 'Room A dev viewer state receipts, parsed in a socket client worker',
    cpu: 'process.cpuUsage over the window: every thread, including the socket client worker' },
  contention: lock.contention(), results };
  if (args.has('out')) await writeFile(args.get('out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (results.some(r => r.errors.length || r.recorder.some(x => x.droppedFrames))) process.exitCode = 1;
} finally { lock.release(); }
