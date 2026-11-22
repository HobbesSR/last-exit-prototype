// Headless tick comparison for the core's per-tick work (42.69 onwards; #1214's step 6 bench, 6e.6). Run from the
// repository root:
// node --experimental-strip-types tests/bench-phase-three.mjs [--root=PATH] [--cache=PATH] [--rounds=N] [--traps]
// `--root` names the tree to time (a baseline is a `git archive` of a whole commit with its core built there by
// `node tools/build-core.mjs`); the map cache is shared, so both sides tick the same map. `--traps` places a trap of
// each kind on every third item, as the default map has none. Every `sim.*` label the tree records is reported as its
// median of the rounds' means, so trees with different labels compare by the whole tick and by their own groups.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { acquireMachineLock } from './helpers/machine-lock.js';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const root = path.resolve(String(args.get('root') ?? process.cwd()));
const rounds = Number(args.get('rounds') ?? 5);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
const withTraps = args.has('traps');
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
const [simulation, profiler, live, contentModule, routes, freeSpace] = await Promise.all([
  load('shared/simulation.ts'), load('shared/profiler.ts'), load('map/live.ts'),
  load('shared/simulation/content.ts'), load('shared/simulation/bot-routes.ts'), load('shared/free-space.ts'),
]);
const { createGame, disposePhysics, step, snapshot } = simulation;
const content = contentModule.contentById(contentModule.CONTENT_ID);
const size = live.liveZoneSize({ zoneWidth: 24, zoneHeight: 12 });
const seed = 4217;
const cachePath = path.resolve(String(args.get('cache') ?? path.join(process.cwd(), 'test-results', 'phase-three-map.v8')));
const lock = await acquireMachineLock('bench');
try {
  await mkdir(path.dirname(cachePath), { recursive: true });
  let serialized;
  try { serialized = await readFile(cachePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const map = live.generateLiveMap(seed, content, size);
    for (const packed of routes.prebuiltTiles(map, content)) freeSpace.adoptPackedTiles(map, packed);
    serialized = v8.serialize(map);
    await writeFile(cachePath, serialized, { flag: 'wx' }).catch(async writeError => {
      if (writeError.code !== 'EEXIST') throw writeError;
      serialized = await readFile(cachePath);
    });
  }
  const results = [];
  for (let round = 0; round < rounds; round++) {
    const map = v8.deserialize(serialized);
    if (withTraps) {
      const kinds = ['mine', 'turret', 'flame', 'spider'];
      map.traps = map.items.filter((_, i) => i % 3 === 0).map((item, i) => {
        const kind = kinds[i % 4], trap = { id: `trap-${i}`, kind, x: item.x, y: item.y };
        if (kind === 'spider') Object.assign(trap, { homeX: item.x, homeY: item.y });
        if (kind !== 'mine' && i % 3) trap.heading = (i * 0.7) % 6;
        if (kind === 'flame') trap.offset = i * 7;
        if (i % 5) trap.cooldown = 0;
        return trap;
      });
    }
    const game = await createGame(seed, map, content);
    profiler.enable(true);
    for (let i = 0; i < 300; i++) { step(game); snapshot(game); profiler.frame(); }
    profiler.reset(); profiler.enable(true);
    const started = performance.now();
    for (let i = 0; i < 600; i++) { step(game); snapshot(game); profiler.frame(); }
    const elapsedMs = performance.now() - started;
    const rows = profiler.report();
    const actions = rows.find(row => row.name === 'sim.actions');
    const coreActions = rows.find(row => row.name === 'sim.actions.core');
    const labels = Object.fromEntries(rows.filter(row => row.name.startsWith('sim.') && row.unit === 'ms')
      .map(row => [row.name, row.mean]));
    results.push({ round: round + 1, meanTickAndSnapshotMs: elapsedMs / 600, labels, live: game.phase,
      simActionsMeanMs: actions?.mean ?? null,
      simActionsCoreMeanMs: coreActions?.mean ?? null,
      simActionsMinusCoreMs: actions && coreActions ? actions.mean - coreActions.mean : null });
    profiler.enable(false);
    disposePhysics(game);
  }
  const middle = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const median = key => middle(results.map(row => row[key]));
  const names = [...new Set(results.flatMap(row => Object.keys(row.labels)))].sort();
  const medianLabels = Object.fromEntries(names.map(name => [name, middle(results.map(row => row.labels[name] ?? 0))]));
  console.log(JSON.stringify({ root, cache: cachePath, seed, size: '24x12', warmTicks: 300, timedTicks: 600,
    rounds, withTraps, results, medianLabels, medianMeanTickAndSnapshotMs: median('meanTickAndSnapshotMs'),
    medianSimActionsMeanMs: median('simActionsMeanMs'),
    medianSimActionsCoreMeanMs: median('simActionsCoreMeanMs'),
    medianSimActionsMinusCoreMs: median('simActionsMinusCoreMs'), contention: lock.contention() }, null, 2));
} finally { lock.release(); }
