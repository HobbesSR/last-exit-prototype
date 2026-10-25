// Measure #424, bots planning over free-space tiles (22.6 stage 4): whole bot-only live-chain
// matches under each content in CONTENTS (default content-3, tiles searched within a tick, and
// content-4, searches sliced over ticks, #470; content-5 adds local repair, #470 part 2; content-2 is
// the grid planner), and route quality
// against the unrestricted grid search. node tools/navigation/adoption-report.mjs [output.json]
// Runs sequentially under the bench lock. COLD=1 leaves gladiators to build their tiles on their
// first plans, as 42.8 measured; by default each match adopts the tiles a map worker would build,
// as a room does (22.6, "Tiles built ahead").
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { generateLiveMap, LIVE_ZONE_SIZES, zoneSizeName } from '../../map/live.ts';
import { createGame, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createKnowledgePlanner } from '../../shared/navigation/knowledge.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { discoveryGrid } from '../../shared/discovery.ts';
import { gridRoute } from '../../shared/map/route.ts';
import { straightenPath } from '../../shared/map.ts';
import { TILE } from '../../shared/movement.ts';
import * as profiler from '../../shared/profiler.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const SEEDS = { '12x6': Number(process.env.SEEDS_12 ?? 8), '24x12': Number(process.env.SEEDS_24 ?? 3), '36x18': Number(process.env.SEEDS_36 ?? 2) };
const CONTENTS = (process.env.CONTENTS ?? 'content-3,content-4').split(',');
const SOURCES = ['shared/simulation/bots.ts', 'shared/navigation/knowledge.ts', 'shared/free-space.ts', 'shared/shape-construction.ts', 'shared/discovery.ts', 'shared/map/route.ts',
  'shared/simulation/content.ts', 'tools/navigation/adoption-report.mjs'];
const ROUTES = process.env.ROUTES !== '0', COLD = process.env.COLD === '1';
/** A stall: an active contestant, not charging, that moves under STALL_RANGE units in STALL_TICKS ticks. */
const STALL_TICKS = 100, STALL_RANGE = 40;
const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const pathLength = points => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
/** Turns sharper than ten degrees: the kinks a walker would show. */
const kinks = points => points.slice(1, -1).filter((p, i) => {
  const a = points[i], b = points[i + 2], u = Math.atan2(p.y - a.y, p.x - a.x), v = Math.atan2(b.y - p.y, b.x - p.x);
  return Math.abs(Math.atan2(Math.sin(v - u), Math.cos(v - u))) > Math.PI / 18;
}).length;

/** One whole bot-only match. */
function playMatch(map, seed, contentId, packed) {
  const copy = structuredClone(map);
  for (const tiles of packed) adoptPackedTiles(copy, tiles);
  const s = createGame(seed, copy, contentById(contentId));
  profiler.reset(); profiler.enable(true);
  const ticks = [], anchor = new Map(), stalls = [];
  let repaths = 0, exhausted = 0, slices = 0, backtracked = 0, repairs = 0, repairsFailed = 0, repairsDeferred = 0, waiting = 0, doorsOpened = 0;
  const open = new Map(s.map.gates.map(g => [g.id, g.open]));
  // The profiler keeps a window of frames, so its repath counts are folded in before it fills.
  const fold = () => {
    for (const row of profiler.report()) {
      const total = row.mean * row.samples;
      if (row.name === 'work.repath') repaths += total; else if (row.name === 'work.route.exhausted') exhausted += total; else if (row.name === 'work.route.slices') slices += total;
      else if (row.name === 'work.route.backtracked') backtracked += total;
      else if (row.name === 'work.route.repairs') repairs += total; else if (row.name === 'work.route.repairFailed') repairsFailed += total;
      else if (row.name === 'work.route.repairDeferred') repairsDeferred += total;
      else if (row.name === 'work.route.waiting') waiting += total;
    }
    profiler.reset();
  };
  while (s.phase === 'live') {
    const start = performance.now(); step(s); ticks.push(performance.now() - start);
    profiler.frame();
    if (s.tick % 500 === 0) fold();
    for (const g of s.map.gates) { if (g.open && !open.get(g.id)) doorsOpened++; open.set(g.id, g.open); }
    for (const p of s.players) if (p.role === 'contestant') {
      if (p.status !== 'active' || p.charging) { anchor.delete(p.id); continue; }
      const at = anchor.get(p.id);
      if (!at || Math.hypot(p.x - at.x, p.y - at.y) >= STALL_RANGE) anchor.set(p.id, { x: p.x, y: p.y, tick: s.tick, counted: false });
      else if (s.tick - at.tick >= STALL_TICKS && !at.counted) { at.counted = true; stalls.push({ name: p.name, tick: at.tick, x: Math.round(p.x), y: Math.round(p.y) }); }
    }
  }
  fold(); profiler.enable(false);
  const sorted = [...ticks].sort((a, b) => a - b), contestants = s.players.filter(p => p.role === 'contestant');
  return { content: contentId, ticks: s.tick, escaped: contestants.filter(p => p.status === 'escaped').length,
    eliminated: contestants.filter(p => p.status === 'eliminated').length, meanMs: ticks.reduce((a, b) => a + b, 0) / ticks.length,
    p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1), maxAt: ticks.indexOf(sorted.at(-1)) + 1, over50: ticks.filter(t => t > 50).length,
    repaths: Math.round(repaths), exhausted: Math.round(exhausted), slices: Math.round(slices), backtracked: Math.round(backtracked),
    repairs: Math.round(repairs), repairsFailed: Math.round(repairsFailed), repairsDeferred: Math.round(repairsDeferred), waiting: Math.round(waiting), doorsOpened, stalls };
}

/** Spawn → exit with everything known, and with the half nearer the spawn known: length and kinks against the unrestricted grid route. */
function routeQuality(map) {
  const planner = createKnowledgePlanner(map, 'contestant'), { cols } = discoveryGrid(map);
  const doors = new Map(map.gates.map(g => [g.id, { open: g.open, locked: !!g.locked }]));
  const knowing = known => ({ known, door: id => doors.get(id), keys: 0, revision: 0 });
  const from = map.spawns[0], to = map.exit, half = Math.floor((from.x + to.x) / 2 / discoveryGrid(map).size);
  const full = { x: 0, y: 0, width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) };
  const timed = fn => { const start = performance.now(); const value = fn(); return { ms: performance.now() - start, value }; };
  const grid = timed(() => gridRoute(map, 'contestant', full, from, to, true));
  const gridPoints = [from, ...straightenPath(map, 'contestant', from, grid.value ?? [], true).map(([x, y]) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE })), to];
  const result = { grid: { ms: grid.ms, length: pathLength(gridPoints), kinks: kinks(gridPoints) } };
  for (const [name, known] of [['full', () => true], ['half', cell => cell % cols <= half]]) {
    const route = timed(() => planner.route(knowing(known), from, to));
    result[name] = { ms: route.ms, status: route.value.status, expansions: route.value.expansions, length: route.value.length,
      stretch: route.value.length / result.grid.length, kinks: kinks(route.value.points) };
  }
  return result;
}

const lock = await acquireMachineLock('bench');
try {
  const out = process.argv[2] ?? 'test-results/navigation-424.json';
  const report = { cold: COLD, revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), created: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cpuCount: os.cpus().length,
    sourceHashes: Object.fromEntries(SOURCES.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), maps: [] };
  for (const size of LIVE_ZONE_SIZES) for (let seed = 1; seed <= SEEDS[zoneSizeName(size)]; seed++) {
    console.error(`Measuring ${zoneSizeName(size)} seed ${seed}`);
    const map = generateLiveMap(seed, contentById('content-3'), size);
    report.maps.push({ size: zoneSizeName(size), seed, routes: ROUTES ? routeQuality(map) : null, matches: CONTENTS.map(id => playMatch(map, seed, id, COLD ? [] : prebuiltTiles(map, contentById(id)))) });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
} finally { lock.release(); }
