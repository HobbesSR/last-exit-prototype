// Per-tick stage attribution (#637, 42.22): runs whole rooms as the server loop does, without sockets or a clock.
// Each tick is the loop body of server/room-service.js for every room in turn: the match advances (step, snapshot),
// the frame goes to a replay writer and the spectator history, and broadcast projects, encodes and serializes it for
// every session. The writer's gzip output is discarded, and the loop yields between ticks so its compression keeps
// pace as it would on the server. Every tick's sim.* and loop.* timers are kept, not only the profiler's window, so
// any tick over budget can be attributed. Sessions are viewers attached to bot seats: a bot keeps deciding, which a
// joined player would not, so this is the bot room's cost plus the views.
//
// --size=12x6 --content=<id> --seed --ticks --rooms --clients=<player views> --spectators --no-record
// --tile=CxR repeats the --size map on a CxR grid at the same density (tests/helpers/tile-map.js), for sizes the
// protocol does not serve. --out=<file.json> keeps the raw per-tick series.
import { writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { HZ, DURATION } from '../shared/simulation.ts';
import * as profiler from '../shared/profiler.ts';
import { acquireMachineLock } from './helpers/machine-lock.js';
import { generateLiveMap, liveZoneSize, zoneSizeName, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES } from '../map/live.ts';
import { contentById, CONTENT_ID } from '../shared/simulation/content.ts';
import { prebuiltTiles } from '../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../shared/free-space.ts';
import { createMatchFor } from '../server/match.js';
import { remember, broadcast, viewEncoders } from '../server/room-views.js';
import { createReplayWriter } from '../server/replay-writer.js';
import { SCHEMA, minimumReaderForMatch } from '../shared/recording.ts';
import { tileMap } from './helpers/tile-map.js';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const number = (key, fallback) => Number(args.get(key) ?? fallback);
const seed = number('seed', 4217), ticks = number('ticks', DURATION), roomCount = number('rooms', 1);
const clients = number('clients', 1), spectators = number('spectators', 0), recording = !args.has('no-record');
const budget = 1000 / HZ;
const [zoneWidth, zoneHeight] = (args.get('size') ?? zoneSizeName(DEFAULT_LIVE_ZONE_SIZE)).split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error(`--size must be one of ${LIVE_ZONE_SIZES.map(zoneSizeName).join(', ')}`); process.exit(2); }
const [columns, rows] = (args.get('tile') ?? '1x1').split('x').map(Number);
const label = columns * rows > 1 ? `${zoneWidth * columns}x${zoneHeight * rows} (${zoneSizeName(size)} tiled ${columns}x${rows})` : zoneSizeName(size);
const baseContent = contentById(args.get('content') ?? CONTENT_ID);

await acquireMachineLock('bench');
const discard = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
async function buildRoom(i) {
  let map = generateLiveMap(seed + i, baseContent, size);
  let content = baseContent;
  if (columns * rows > 1) {
    map = tileMap(map, columns, rows);
    // The synthetic map holds more ground items than any served size; only its capacity check is widened.
    const capacity = baseContent.itemInstances?.groundCapacity;
    if (capacity !== undefined && map.items.length > capacity) content = { ...baseContent, itemInstances: { ...baseContent.itemInstances, groundCapacity: 2 ** Math.ceil(Math.log2(map.items.length)) } };
  }
  const built = performance.now();
  for (const packed of prebuiltTiles(map, content)) adoptPackedTiles(map, packed);
  const tilesMs = performance.now() - built;
  const match = await createMatchFor(seed + i, size, map, content);
  const room = { match, history: [], clients: new Set(), ...viewEncoders(), items: map.items.length, obstacles: map.obstacles.length, tilesMs };
  const players = match.diagnosticState.players;
  for (let c = 0; c < clients; c++) room.clients.add({ playerId: players[c % players.length].id, deliver: () => true });
  for (let c = 0; c < spectators; c++) room.clients.add({ playerId: undefined, deliver: () => true });
  if (recording) {
    const fullMap = match.map();
    room.writer = createReplayWriter({ header: { version: match.version, schema: SCHEMA, minSchema: minimumReaderForMatch(fullMap, match.hasPhysics === true), contentId: match.contentId, id: `bench-${i}`, seed: seed + i, hz: HZ, createdAt: 0, map: fullMap },
      output: discard(), publish: async () => {}, onError: error => { throw error; } });
    room.writer.append(match.snapshot(), [{ type: 'start' }]);
  }
  remember(room, match.snapshot());
  return room;
}
const rooms = [];
for (let i = 0; i < roomCount; i++) rooms.push(await buildRoom(i));

const gc = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({ at: e.startTime, ms: e.duration, kind: e.detail?.kind ?? e.kind }); });
observer.observe({ entryTypes: ['gc'] });
profiler.enable(true);
const totals = [], starts = [], frames = [], memory = [], tickNumbers = [];
let completed = 0;
for (let tick = 0; tick < ticks; tick++) {
  const before = performance.now();
  for (const room of rooms) {
    if (room.match.phase !== 'live') continue;
    const state = room.match.advance();
    if (room.writer) { profiler.start('loop.record'); room.writer.append(state, []); profiler.stop('loop.record'); }
    profiler.start('loop.remember'); remember(room, state); profiler.stop('loop.remember');
    profiler.start('loop.broadcast'); broadcast(room, state); profiler.stop('loop.broadcast');
  }
  const after = performance.now();
  starts.push(before); totals.push(after - before); frames.push(profiler.frame()); tickNumbers.push(rooms[0].match.tick);
  completed = tick + 1;
  if (tick % 250 === 0) memory.push({ tick, heapMB: process.memoryUsage().heapUsed / 2 ** 20, rssMB: process.memoryUsage().rss / 2 ** 20 });
  if (rooms.every(r => r.match.phase !== 'live')) break;
  await new Promise(resolve => setImmediate(resolve));
}
await new Promise(resolve => setTimeout(resolve, 50));
observer.disconnect();
const historyBytes = rooms.map(r => v8.serialize(r.history).byteLength);
const stateBytes = rooms.map(r => v8.serialize(r.history.at(-1)).byteLength);
for (const room of rooms) { room.writer?.abort(new Error('bench finished')); room.match.dispose(); }

// Attribute: every tick's series, the top-level stages that partition it, and what no timer covers.
const names = [...new Set(frames.flatMap(f => Object.keys(f ?? {})))].sort();
const series = Object.fromEntries(names.map(name => [name, frames.map(f => f?.[name] ?? 0)]));
const TOP = ['sim.step', 'sim.snapshot', 'loop.record', 'loop.remember', 'loop.broadcast'];
const untimed = totals.map((t, i) => t - TOP.reduce((sum, name) => sum + (series[name]?.[i] ?? 0), 0));
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { mean: values.reduce((a, b) => a + b, 0) / (values.length || 1), p50: at(0.5), p99: at(0.99), max: sorted.at(-1) ?? 0 };
};
const tickStats = stats(totals);
const counted = name => name.startsWith('work.') || name.startsWith('calls.') || name.startsWith('loop.views');
const stages = Object.fromEntries([...names, 'untimed'].map(name => {
  const values = name === 'untimed' ? untimed : series[name];
  const s = stats(values);
  return [name, { ...s, share: counted(name) ? null : s.mean / tickStats.mean }];
}));
// Ticks over budget: the stages that took them there and any collection that overlapped them.
const gcIn = (i) => gc.filter(e => e.at < starts[i] + totals[i] && e.at + e.ms > starts[i]);
const leaves = names.filter(n => !counted(n) && !['sim.step', 'sim.snapshot', 'loop.broadcast'].includes(n));
const over = totals.flatMap((t, i) => t <= budget ? [] : [{
  index: i, tick: tickNumbers[i], ms: t,
  top: Object.fromEntries([...TOP, 'untimed'].map(n => [n, n === 'untimed' ? untimed[i] : series[n]?.[i] ?? 0])),
  largest: leaves.map(n => [n, series[n][i]]).sort((a, b) => b[1] - a[1]).slice(0, 4),
  rekeys: Object.fromEntries(names.filter(n => n.startsWith('work.rekey.') && series[n][i]).map(n => [n.slice(11), series[n][i]])),
  gcMs: gcIn(i).reduce((sum, e) => sum + e.ms, 0),
}]);
const result = {
  meta: { seed, content: baseContent.id, size: label, rooms: roomCount, clients, spectators, recording, ticks: completed, node: process.version,
    items: rooms.map(r => r.items), obstacles: rooms.map(r => r.obstacles), tilesMs: rooms.map(r => r.tilesMs) },
  tick: { ...tickStats, over: over.length }, stages, over,
  gc: { count: gc.length, ms: gc.reduce((a, e) => a + e.ms, 0), max: Math.max(0, ...gc.map(e => e.ms)) },
  memory: { samples: memory, historyFrames: rooms.map(r => r.history.length), historyBytes, stateBytes },
};
if (args.has('out')) await writeFile(args.get('out'), JSON.stringify({ ...result, raw: { totals, series, untimed, gc } }));

const ms = v => v.toFixed(2).padStart(7);
console.log(`Stage attribution — seed ${seed}, ${baseContent.id}, ${label}, ${roomCount} room(s), ${clients} viewer(s), ${spectators} spectator(s), recording ${recording ? 'on' : 'off'}, ${completed} ticks`);
console.log(`items ${result.meta.items.join('/')}  obstacles ${result.meta.obstacles.join('/')}`);
console.log(`tick       mean ${ms(tickStats.mean)}  p99 ${ms(tickStats.p99)}  max ${ms(tickStats.max)}  over ${budget} ms: ${over.length}`);
for (const [name, s] of Object.entries(stages).sort((a, b) => b[1].mean - a[1].mean)) {
  console.log(`${name.padEnd(28)} mean ${ms(s.mean)}  p99 ${ms(s.p99)}  max ${ms(s.max)}${s.share === null ? '' : `  ${(s.share * 100).toFixed(1).padStart(5)}%`}`);
}
for (const o of over) console.log(`over: tick ${o.tick} ${o.ms.toFixed(1)} ms  gc ${o.gcMs.toFixed(1)}  ${o.largest.map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')}  ${JSON.stringify(o.rekeys)}`);
console.log(`gc ${gc.length} pauses, ${result.gc.ms.toFixed(0)} ms total, max ${result.gc.max.toFixed(1)} ms; history ${result.memory.historyFrames.join('/')} frames, ${historyBytes.map(b => (b / 2 ** 20).toFixed(1)).join('/')} MiB serialized; state ${stateBytes.map(b => (b / 1024).toFixed(0)).join('/')} KiB`);
