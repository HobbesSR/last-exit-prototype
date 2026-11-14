// Headless tick benchmark: runs the real simulation with no sockets, disk, or renderer so the
// numbers describe the simulation itself rather than the machine's I/O. Mirrors the server loop
// body (step, snapshot, per-client view) because that whole sequence shares the 1000/HZ budget.
import { createGame, disposePhysics, step, snapshot, playerView, HZ, DURATION } from '../shared/simulation.ts';
import * as profiler from '../shared/profiler.ts';
import { acquireMachineLock } from './helpers/machine-lock.js';
import { generateLiveMap, liveZoneSize, zoneSizeName, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES } from '../map/live.ts';
import { contentById, CONTENT_ID } from '../shared/simulation/content.ts';
import { prebuiltTiles } from '../shared/simulation/bot-routes.ts';
import { adoptPackedTiles } from '../shared/free-space.ts';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const number = (key, fallback) => Number(args.get(key) ?? fallback);
const seed = number('seed', 4217), ticks = number('ticks', DURATION), rooms = number('rooms', 1), clients = number('clients', 1);
const budget = 1000 / HZ;
const [zoneWidth, zoneHeight] = (args.get('size') ?? zoneSizeName(DEFAULT_LIVE_ZONE_SIZE)).split('x').map(Number);
const size = liveZoneSize({ zoneWidth, zoneHeight });
if (!size) { console.error(`--size must be one of ${LIVE_ZONE_SIZES.map(zoneSizeName).join(', ')}`); process.exit(2); }
// `--content=<id>` measures another shipped content set. The default is what a live room ships. Every game runs on the
// physics engine, so it is built with createGame and disposed at the end.
const contentId = args.get('content') ?? CONTENT_ID;
// Rooms adopt the tiles their map worker built (22.6, "Bot adoption"), untimed here as there; `--cold` leaves bots to build them.
const prepared = map => { if (!args.has('cold')) for (const packed of prebuiltTiles(map, contentById(contentId))) adoptPackedTiles(map, packed); return map; };

const lock = await acquireMachineLock('bench');
try {
  profiler.enable(true);
  const build = (i) => {
    const map = prepared(generateLiveMap(seed + i, contentById(contentId), size));
    return createGame(seed + i, map, contentById(contentId));
  };
  const games = await Promise.all(Array.from({ length: rooms }, (_, i) => build(i)));
  const viewers = Array.from({ length: clients }, (_, i) => games[0].players[i % games[0].players.length].id);
  const durations = [];
  const started = performance.now(), cpuStarted = process.cpuUsage();
  let completed = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const before = performance.now();
    for (const game of games) {
      if (game.phase !== 'live') continue;
      step(game);
      const state = snapshot(game);
      for (const id of viewers) playerView(game, state, id);
    }
    durations.push(performance.now() - before);
    profiler.frame();
    completed = tick + 1;
    if (games.every(g => g.phase !== 'live')) break;
  }
  const wall = performance.now() - started, cpu = process.cpuUsage(cpuStarted);
  const cpuMs = (cpu.user + cpu.system) / 1000, contention = lock.contention();
  for (const game of games) disposePhysics(game);
  const sorted = [...durations].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const over = durations.filter(d => d > budget).length;
  const stats = { seed, content: contentId, cold: args.has('cold'), size: zoneSizeName(size), rooms, clients, ticks: completed,
    wallMs: wall, cpuMs, userCpuMs: cpu.user / 1000, systemCpuMs: cpu.system / 1000, contention,
    meanMs: mean, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted[sorted.length - 1],
    budgetMs: budget, budgetUsedPct: mean / budget * 100, overBudgetTicks: over, sustainableHz: 1000 / at(0.95), roomHeadroom: Math.floor(budget / (at(0.95) / rooms)) };

  if (args.has('json')) { console.log(JSON.stringify({ stats, series: profiler.report() }, null, 2)); process.exit(0); }
  const ms = v => `${v.toFixed(3)} ms`;
  console.log(`Last Exit tick benchmark — seed ${seed}, ${contentId}${args.has('cold') ? ' (cold tiles)' : ''}, ${zoneSizeName(size)}, ${rooms} room(s), ${clients} viewer(s), ${completed} ticks in ${wall.toFixed(0)} ms (CPU ${cpuMs.toFixed(0)} ms${contention.contended ? `, CONTENDED ${(contention.otherBusyShare * 100).toFixed(1)}%` : ''})`);
  console.log(`tick cost   mean ${ms(mean)}   p50 ${ms(stats.p50Ms)}   p95 ${ms(stats.p95Ms)}   p99 ${ms(stats.p99Ms)}   max ${ms(stats.maxMs)}`);
  console.log(`budget      ${ms(budget)} at ${HZ} Hz — mean uses ${stats.budgetUsedPct.toFixed(1)}%, ${over} of ${completed} ticks over budget`);
  console.log(`headroom    sustainable ${stats.sustainableHz.toFixed(0)} Hz at p95, about ${stats.roomHeadroom} concurrent room(s) inside budget`);
  console.log(profiler.format());
  console.log('\nsim.step and sim.snapshot are inclusive: their phases (sim.bots, sim.solve, sim.snapshot.clone and the rest) are counted inside them.');
  console.log('tests/bench-stages.mjs keeps every tick of every stage, with recording and broadcast (42.22).');
} finally {
  lock.release();
}
