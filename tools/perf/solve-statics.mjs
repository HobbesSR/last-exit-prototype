// Whether static collider count drives sim.solve (#670 stage 0, 42.22). Plays the same physics match twice from one
// seed. At tick FROM, one copy removes every static map collider farther than RADIUS from all players and admitted
// item bodies; both then run WINDOW ticks, and sim.solve over that window is compared with the moving bodies the same.
// Players' positions are compared tick by tick, so a run where something reached a removed wall is reported, not used.
// node tools/perf/solve-statics.mjs --size=36x18 --seed=4217 --content=content-11 --from=300 --window=600 --radius=6000 --repeats=3
import { generateLiveMap, liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { buildPhysicsGeometry } from '../../shared/simulation/physics-geometry.ts';
import { physicsRuntime } from '../../shared/simulation/physics-runtime.ts';
import { createMatchFor } from '../../server/match.js';
import * as profiler from '../../shared/profiler.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';

const args = cliArgs(), number = (key, fallback) => Number(args.get(key) ?? fallback);
const [zoneWidth, zoneHeight] = (args.get('size') ?? '36x18').split('x').map(Number);
const seed = number('seed', 4217), from = number('from', 300), window = number('window', 600), radius = number('radius', 6000);
const repeats = number('repeats', 3), content = contentById(args.get('content') ?? 'content-11'), zone = liveZoneSize({ zoneWidth, zoneHeight });

async function play(prune) {
  const map = generateLiveMap(seed, content, zone);
  for (const tiles of prebuiltTiles(map, content)) adoptPackedTiles(map, tiles);
  const match = await createMatchFor(seed, zone, map, content), s = match.diagnosticState, world = physicsRuntime(s).world;
  const statics = buildPhysicsGeometry(s.map);
  const sums = { solve: 0, tick: 0 }, trace = [];
  let kept = statics.length;
  profiler.reset(); profiler.enable(true);
  for (let t = 1; t <= from + window && s.phase === 'live'; t++) {
    if (t === from + 1 && prune) {
      const near = [...s.players.filter(p => p.status === 'active'), ...s.map.items.filter(i => physicsRuntime(s).items.has(i.id))];
      const far = statics.filter(body => near.every(q => Math.hypot(q.x - body.x, q.y - body.y) > radius));
      for (let i = 0; i < far.length; i++) { world.queueRemoveBody(far[i].id); if (i % 512 === 511) world.commitMutations(); }
      world.commitMutations();
      kept = statics.length - far.length;
    }
    match.advance();
    const frame = profiler.frame() ?? {};
    if (t > from) { sums.solve += frame['sim.solve'] ?? 0; sums.tick += frame['sim.step'] ?? 0; }
    trace.push(s.players.map(p => `${p.x},${p.y},${p.status}`).join('|'));
  }
  profiler.enable(false); match.dispose();
  return { statics: statics.length, kept, solve: sums.solve / window, step: sums.tick / window, trace };
}

await acquireMachineLock('bench');
console.log(`seed ${seed}, ${content.id}, ${zoneWidth}x${zoneHeight}: ticks ${from + 1}–${from + window}, statics farther than ${radius} removed at tick ${from}`);
for (let r = 0; r < repeats; r++) for (const prune of [false, true]) {
  const run = await play(prune);
  if (!prune) play.base = run.trace;
  const diverged = prune ? run.trace.findIndex((line, i) => line !== play.base[i]) : -1;
  console.log(`${prune ? 'pruned' : 'full  '} statics ${run.kept}/${run.statics}  sim.solve ${run.solve.toFixed(2)} ms  sim.step ${run.step.toFixed(2)} ms${diverged >= 0 ? `  DIVERGED at tick ${diverged + 1}` : ''}`);
}
