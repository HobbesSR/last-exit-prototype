// Discovery's cost inside the tick (#1210, docs/42.62): the same seeded live match as
// tools/physics/bench-step.mjs (content-7, seed 4217, the default live size, bots), 1,000 ticks after
// 100 of warmup, three games per run, under the machine bench lock. It reads the profiler's
// `sim.discovery` per tick. Inside it, it times the visibility polygon when discovery asks for one
// (the TypeScript rule), or the core's sample when discovery runs there (#1210): the time from the
// input's last write to the output's return is the core's, and the rest of `sim.discovery` is the
// adapter's packing and unpacking.
//
//   node tools/discovery/bench-discovery.mjs <repository root> <label>
//
// The root may be another checkout, so the TypeScript discovery can be measured against the core's.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const at = file => import(pathToFileURL(path.join(root, file)).href);
const { acquireMachineLock } = await at('tests/helpers/machine-lock.js');
const { createGame, step, disposePhysics } = await at('shared/simulation.ts');
const { contentById } = await at('shared/simulation/content.ts');
const { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } = await at('map/live.ts');
const { prebuiltTiles } = await at('shared/simulation/bot-routes.ts');
const { adoptPackedTiles } = await at('shared/free-space.ts');
const { initCoreSight } = await at('shared/sight-core.ts');
const profiler = await at('shared/profiler.ts');
const lock = await acquireMachineLock('bench');
// The caster is the process's one object, so wrapping its method times every polygon discovery builds.
const sight = await initCoreSight();
let polygon = 0, polygons = 0;
const cast = sight.visibilityPolygon;
sight.visibilityPolygon = function (...args) {
  const t = performance.now();
  try { return cast.apply(this, args); } finally { polygon += performance.now() - t; polygons++; }
};
let core = 0, packing = 0, samples = 0;
const sample = sight.sampleDiscovery;
if (sample) sight.sampleDiscovery = function (map, tables, lineOfSight, words, fill) {
  let filled = 0;
  try { return sample.call(this, map, tables, lineOfSight, words, input => { const t = performance.now(); fill(input); filled = performance.now(); packing += filled - t; }); }
  finally { core += performance.now() - filled; samples++; }
};
const content = contentById('content-7');
const map = generateLiveMap(4217, content, DEFAULT_LIVE_ZONE_SIZE);
const rows = [];
profiler.enable(true);
for (let run = 0; run < 3; run++) {
  const arena = structuredClone(map);
  for (const tiles of prebuiltTiles(arena, content)) adoptPackedTiles(arena, tiles);
  const s = await createGame(4217, arena, content);
  const ticks = [], discovery = [], polys = [], cores = [], packs = [];
  let calls = 0, sampled = 0;
  try {
    for (let tick = 0; tick < 1100 && s.phase === 'live'; tick++) {
      polygon = 0; core = 0; packing = 0;
      const t = performance.now();
      step(s);
      const elapsed = performance.now() - t;
      const totals = profiler.frame() ?? {};
      if (tick >= 100) { ticks.push(elapsed); discovery.push(totals['sim.discovery'] ?? 0); polys.push(polygon); cores.push(core); packs.push(packing); calls += polygons; sampled += samples; }
      polygons = 0; samples = 0;
    }
  } finally { disposePhysics(s); }
  const q = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const rest = discovery.map((d, i) => d - polys[i] - cores[i]);
  rows.push({ run, samples: ticks.length, players: s.players.length, tickMean: mean(ticks), discoveryMean: mean(discovery),
    discoveryP50: q(discovery, .5), discoveryP95: q(discovery, .95), polygonMean: mean(polys), polygonsPerTick: calls / ticks.length,
    coreMean: mean(cores), inputWritesMean: mean(packs), samplesPerTick: sampled / ticks.length,
    restMean: mean(rest), restP95: q(rest, .95) });
}
await lock.release();
console.log(JSON.stringify({ label: process.argv[3], node: process.version, rows }, null, 1));
