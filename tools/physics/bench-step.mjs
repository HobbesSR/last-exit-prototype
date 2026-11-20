// The physics step against the whole tick (#1192, docs/42.61): the same seeded live match (content-7,
// seed 4217, the default live size, bots), 1,000 ticks after 100 of warmup, three games per run. It times
// each `step(s)` and, inside it, `PhysicsWorld.step`, under the machine bench lock.
//
//   node tools/physics/bench-step.mjs <repository root> <label>
//
// The root may be another checkout, so an older engine can be measured against this one.
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
const { PhysicsWorld } = await at('shared/physics/world.ts');
const lock = await acquireMachineLock('bench');
let inside = 0;
const original = PhysicsWorld.prototype.step;
PhysicsWorld.prototype.step = function (...args) {
  const t = performance.now();
  try { return original.apply(this, args); } finally { inside += performance.now() - t; }
};
const content = contentById('content-7');
const map = generateLiveMap(4217, content, DEFAULT_LIVE_ZONE_SIZE);
const rows = [];
for (let run = 0; run < 3; run++) {
  const arena = structuredClone(map);
  for (const tiles of prebuiltTiles(arena, content)) adoptPackedTiles(arena, tiles);
  const s = await createGame(4217, arena, content);
  const ticks = [], physics = [];
  try {
    for (let tick = 0; tick < 1100 && s.phase === 'live'; tick++) {
      inside = 0;
      const t = performance.now();
      step(s);
      const elapsed = performance.now() - t;
      if (tick >= 100) { ticks.push(elapsed); physics.push(inside); }
    }
  } finally { disposePhysics(s); }
  const q = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  rows.push({ run, samples: ticks.length, tickMean: mean(ticks), tickP50: q(ticks, .5), tickP95: q(ticks, .95),
    physicsMean: mean(physics), physicsP50: q(physics, .5), physicsP95: q(physics, .95) });
}
await lock.release();
console.log(JSON.stringify({ label: process.argv[3], node: process.version, rows }));
