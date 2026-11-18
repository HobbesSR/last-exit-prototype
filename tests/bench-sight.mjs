// The adapter measurement for #1175 stage 2: `visibilityPolygon` in TypeScript against the Rust
// core through the flat-buffer adapter, on the room arena's real map (docs/27, 42.58).
//
//   node tests/bench-sight.mjs [--calls=2000] [--rounds=7] [--radius=620]
//
// Each round times every variant in turn on the same origins, rotating which goes first, so
// machine load is shared: judge by each round's ratio (31). Process CPU is reported beside wall time.
// - `ts`: shared/sight.ts.
// - `core`: shared/sight-core.ts, returning the same point objects.
// - `flat`: the same call, leaving the points in WASM memory: the crossing without building objects.
// - `empty`: a call to `adapter_version`, the floor for one crossing.
import { readFileSync } from 'node:fs';
import { loadCore } from '../shared/core.ts';
import { coreSight } from '../shared/sight-core.ts';
import { visibilityPolygon } from '../shared/sight.ts';
import { insideMap } from '../shared/playable-area.ts';
import { buildCore } from '../tools/build-core.mjs';
import { readArena } from '../tools/room-arena.mjs';
import { acquireMachineLock } from './helpers/machine-lock.js';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const number = (key, fallback) => Number(args.get(key) ?? fallback);
const calls = number('calls', 2000), rounds = number('rounds', 7), radius = number('radius', 620);

const bytes = readFileSync(buildCore());
const lock = await acquireMachineLock('bench');
try {
  const { map } = readArena();
  // Eyes stand on playable ground, from a fixed sequence.
  let state = 5;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const origins = [];
  while (origins.length < calls) {
    const x = next() * map.width, y = next() * map.height;
    if (insideMap(map, x, y)) origins.push({ x, y });
  }

  const exports = await loadCore(bytes);
  // The one-off upload: building the flat index in JavaScript and copying it in.
  const fresh = coreSight(exports);
  const uploadStart = performance.now();
  fresh.visibilityPolygonFlat(map, origins[0], radius);
  const upload = performance.now() - uploadStart;

  const core = coreSight(exports);
  const expected = visibilityPolygon(map, origins[0], radius), actual = core.visibilityPolygon(map, origins[0], radius);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('the core and TypeScript polygons differ; run tests/sight-core.test.js');

  let sink = 0;
  const variants = {
    ts: origin => { sink += visibilityPolygon(map, origin, radius).length; },
    core: origin => { sink += core.visibilityPolygon(map, origin, radius).length; },
    flat: origin => { sink += core.visibilityPolygonFlat(map, origin, radius).length; },
    empty: () => { sink += exports.adapter_version(); },
  };
  const names = Object.keys(variants);
  // Warm every path before timing.
  for (const name of names) for (const origin of origins) variants[name](origin);

  const results = Object.fromEntries(names.map(name => [name, { wall: [], cpu: [] }]));
  for (let round = 0; round < rounds; round++) {
    const order = names.map((_, i) => names[(i + round) % names.length]);
    for (const name of order) {
      const run = variants[name], cpu = process.cpuUsage(), start = performance.now();
      for (const origin of origins) run(origin);
      const wall = performance.now() - start, used = process.cpuUsage(cpu);
      results[name].wall.push(wall * 1000 / calls);
      results[name].cpu.push((used.user + used.system) / calls);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
  const round2 = value => Math.round(value * 100) / 100;
  const ratios = results.ts.wall.map((ts, i) => round2(results.core.wall[i] / ts));
  console.log(JSON.stringify({
    map: { obstacles: map.obstacles.length, gates: map.gates.length, width: map.width, height: map.height },
    calls, rounds, radius, points: expected.length, uploadMs: round2(upload),
    perCallMicros: Object.fromEntries(names.map(name => [name, { wall: round2(median(results[name].wall)), cpu: round2(median(results[name].cpu)) }])),
    coreOverTsByRound: ratios,
    contention: lock.contention(),
    sink: sink > 0,
  }, null, 2));
} finally {
  lock.release();
}
