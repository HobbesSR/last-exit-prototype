// Headless tick benchmark: runs the real simulation with no sockets, disk, or renderer so the
// numbers describe the simulation itself rather than the machine's I/O. Mirrors the server loop
// body (step, snapshot, per-client view) because that whole sequence shares the 1000/HZ budget.
import { createGame, step, snapshot, playerView, HZ, DURATION } from '../shared/simulation.js';
import * as profiler from '../shared/profiler.js';

const args = new Map(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const number = (key, fallback) => Number(args.get(key) ?? fallback);
const seed = number('seed', 4217), ticks = number('ticks', DURATION), rooms = number('rooms', 1), clients = number('clients', 1);
const budget = 1000 / HZ;

profiler.enable(true);
const games = Array.from({ length: rooms }, (_, i) => createGame(seed + i));
const viewers = Array.from({ length: clients }, (_, i) => games[0].players[i % games[0].players.length].id);
const durations = [];
const started = performance.now();
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
const wall = performance.now() - started;
const sorted = [...durations].sort((a, b) => a - b);
const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
const over = durations.filter(d => d > budget).length;
const stats = { seed, rooms, clients, ticks: completed, wallMs: wall, meanMs: mean, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted[sorted.length - 1],
  budgetMs: budget, budgetUsedPct: mean / budget * 100, overBudgetTicks: over, sustainableHz: 1000 / at(0.95), roomHeadroom: Math.floor(budget / (at(0.95) / rooms)) };

if (args.has('json')) { console.log(JSON.stringify({ stats, series: profiler.report() }, null, 2)); process.exit(0); }
const ms = v => `${v.toFixed(3)} ms`;
console.log(`Last Exit tick benchmark — seed ${seed}, ${rooms} room(s), ${clients} viewer(s), ${completed} ticks in ${wall.toFixed(0)} ms`);
console.log(`tick cost   mean ${ms(mean)}   p50 ${ms(stats.p50Ms)}   p95 ${ms(stats.p95Ms)}   p99 ${ms(stats.p99Ms)}   max ${ms(stats.maxMs)}`);
console.log(`budget      ${ms(budget)} at ${HZ} Hz — mean uses ${stats.budgetUsedPct.toFixed(1)}%, ${over} of ${completed} ticks over budget`);
console.log(`headroom    sustainable ${stats.sustainableHz.toFixed(0)} Hz at p95, about ${stats.roomHeadroom} concurrent room(s) inside budget`);
console.log(profiler.format());
console.log('\nsim.step is inclusive: its children (bots, move, actions, pickups, projectiles) are counted inside it.');
