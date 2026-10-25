// P9 synthetic whole-simulation qualification workload. Run sequentially under the bench lock.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { createGame, createPhysicsGame, disposePhysics, playerView, setInput, snapshot, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { physicsRuntime } from '../../shared/simulation/physics-runtime.ts';

const sha = data => createHash('sha256').update(data).digest('hex');
const round = number => Number(number.toFixed(6));
const memory = () => ({ heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss });
const collect = () => { if (global.gc) { global.gc(); global.gc(); } };
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(round), p50: round(percentile(sorted, .5)), p95: round(percentile(sorted, .95)),
    p99: round(percentile(sorted, .99)), max: round(sorted.at(-1)) };
};
const options = argv => {
  const result = { seed: 449, warmup: 40, samples: 200, output: 'test-results/physics-p9-integration.json' };
  for (const arg of argv) {
    const match = /^--(seed|warmup|samples|output)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument ${arg}; use --seed=N --warmup=N --samples=N --output=path`);
    result[match[1]] = match[1] === 'output' ? match[2] : Number(match[2]);
  }
  for (const key of ['seed', 'warmup', 'samples']) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'samples' ? 1 : 0))
    throw new Error(`Invalid --${key}`);
  return result;
};

function arena(seed, actors, props, loot, layout) {
  const width = 17280, height = 8640;
  const crowded = layout === 'clustered';
  return { seed, width, height,
    playableArea: { cellSize: 120, rows: Array.from({ length: 72 }, (_, y) => ({ y, runs: [[0, 144]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [],
    items: Array.from({ length: loot }, (_, i) => ({ id: `p9-loot-${i}`, kind: 'cell', charge: 73,
      x: (crowded ? 8600 : 1500) + i % 13 * (crowded ? 16 : 1100),
      y: (crowded ? 4800 : 7400) + Math.floor(i / 13) * (crowded ? 16 : 120) })),
    traps: [], routes: [], nodes: [], streets: [],
    physicsProps: Array.from({ length: props }, (_, i) => ({ id: `p9-crate-${i.toString().padStart(3, '0')}`,
      profile: 'crate', x: (crowded ? 8500 : 1500) + i % 13 * (crowded ? 60 : 1100),
      y: (crowded ? 3800 : 1000) + Math.floor(i / 13) * (crowded ? 60 : 800) })),
    entry: { x: 160, y: 4320 }, exit: { x: 17100, y: 4320 },
    spawns: Array.from({ length: actors - 3 }, (_, i) => ({ x: (crowded ? 8200 : 2500) + i % 8 * (crowded ? 36 : 1500),
      y: (crowded ? 4200 : 1500) + Math.floor(i / 8) * (crowded ? 36 : 1800) })),
    hunterSpawns: Array.from({ length: 3 }, (_, i) => ({ x: crowded ? 9400 : 14500,
      y: (crowded ? 4250 : 3000) + i * (crowded ? 55 : 900) })) };
}

function contentFor(stage, actors) {
  const id = stage === 'A' ? 'content-physics-2' : stage === 'legacy' ? 'content-5' : 'content-physics-8';
  const content = structuredClone(contentById(id));
  content.discovery = false;
  content.roster = { contestants: Array.from({ length: actors - 3 }, (_, i) => `C${i}`),
    gladiators: Array.from({ length: 3 }, (_, i) => ({ name: `G${i}`, kit: stage === 'C' ? 'hook' : 'warden' })) };
  for (const weapon of Object.values(content.weapons)) weapon.damage = 0;
  for (const kit of Object.values(content.kits)) kit.damage = 0;
  return content;
}

async function runCase(config, options, repeat) {
  const { stage, actors, props, loot, layout } = config;
  const map = arena(options.seed, actors, props, loot, layout), content = contentFor(stage, actors);
  collect(); const beforeInitialization = memory(), initialAt = performance.now();
  const game = stage === 'legacy' ? createGame(options.seed, map, content) : await createPhysicsGame(options.seed, map, content);
  const initializationMs = performance.now() - initialAt, afterInitialization = memory();
  const times = { input: [], step: [], snapshot: [], projection: [], serialization: [], total: [] };
  const sizes = { raw: [], projected: [], rawGzip: [], projectedGzip: [] };
  const orderedState = createHash('sha256');
  const runtime = physicsRuntime(game);
  const awakeCounts = [], sleepingCounts = [];
  const propIds = runtime?.world.snapshot({ includeStatic: false }).bodies
    .filter(body => body.spec.kind === 'prop').map(body => body.spec.id) ?? [];
  let settings = null, initialBodies = null, initialConstraints = null, peakConstraints = 0;
  let disposalMs, afterDisposal, finalTick, finalPhase;
  try {
    for (const player of game.players) player.bot = false;
    if (stage !== 'legacy') {
      initialBodies = runtime.world.snapshot({ includeStatic: false }).bodies.length;
      if (initialBodies !== actors + props + loot || initialBodies > 128)
        throw new Error(`${stage}/${actors}/${layout}: expected ${actors + props + loot} dynamic bodies, observed ${initialBodies}`);
      if (stage === 'C') {
        // The real bounded constraint API; these are synthetic rope load, not eight successful hook shots.
        for (let i = 0; i < 8; i++) runtime.world.queueAddConstraint({ id: `p9-rope-${i}`,
          kind: 'rope', a: `actor:c${i}`, b: `actor:c${(i + 1) % (actors - 3)}`, maxDistance: 240,
          maxForce: 6000, stiffness: 120, damping: 30 });
        runtime.world.commitMutations();
        initialConstraints = runtime.world.counts().constraints;
        if (initialConstraints !== 8) throw new Error(`Expected eight admitted constraints, observed ${initialConstraints}`);
      } else initialConstraints = runtime.world.counts().constraints;
    }
    for (let tick = 0; tick < options.warmup + options.samples; tick++) {
      if (game.phase !== 'live') throw new Error(`${stage}/${actors}/${layout}: match ended at tick ${game.tick}`);
      const totalAt = performance.now();
      const inputAt = performance.now();
      // Keep the advertised prop load awake, rather than timing a sleeping population.
      for (const id of propIds) runtime.world.queueImpulse(id, { x: tick % 2 ? 2 : -2, y: 0 });
      for (const player of game.players) {
        const index = Number(player.id.slice(1));
        const x = (Math.floor(tick / 20) + index) % 2 ? 1 : -1;
        if (!setInput(game, player.id, { seq: tick + 1, x, y: (index % 3) - 1, sneak: false }))
          throw new Error(`Rejected deterministic input for ${player.id} at ${tick}`);
      }
      const inputMs = performance.now() - inputAt;
      const stepAt = performance.now(); step(game); const stepMs = performance.now() - stepAt;
      const snapAt = performance.now(); const state = snapshot(game); const snapshotMs = performance.now() - snapAt;
      const projectionAt = performance.now(); const view = playerView(game, state, game.players[0].id);
      const projectionMs = performance.now() - projectionAt;
      const serializationAt = performance.now(); const raw = JSON.stringify(state), projected = JSON.stringify(view);
      const serializationMs = performance.now() - serializationAt;
      const totalMs = performance.now() - totalAt;
      orderedState.update(raw).update('\n');
      if (runtime) {
        settings = state.physics.settings;
        peakConstraints = Math.max(peakConstraints, state.physics.world.constraints.length);
      }
      if (tick >= options.warmup) {
        if (runtime) {
          const bodies = state.physics.world.bodies;
          if (bodies.length !== initialBodies) throw new Error(`Workload body population changed: ${initialBodies} to ${bodies.length}`);
          sleepingCounts.push(bodies.filter(body => body.transform.sleeping).length);
          awakeCounts.push(bodies.filter(body => !body.transform.sleeping).length);
        }
        for (const [key, value] of Object.entries({ input: inputMs, step: stepMs, snapshot: snapshotMs,
          projection: projectionMs, serialization: serializationMs, total: totalMs })) times[key].push(value);
        sizes.raw.push(Buffer.byteLength(raw)); sizes.projected.push(Buffer.byteLength(projected));
        sizes.rawGzip.push(gzipSync(raw).length); sizes.projectedGzip.push(gzipSync(projected).length);
      }
    }
    finalTick = game.tick; finalPhase = game.phase;
  } finally {
    const at = performance.now(); disposePhysics(game); disposalMs = performance.now() - at;
    collect(); afterDisposal = memory();
  }
  return { ...config, repeat, mapSha256: sha(JSON.stringify(map)), content: content.id, version: game.version,
    dynamicBodies: initialBodies, initialConstraints, peakConstraints, settings, finalTick, finalPhase,
    awakeBodies: awakeCounts.length ? { min: Math.min(...awakeCounts), max: Math.max(...awakeCounts) } : null,
    sleepingBodies: sleepingCounts.length ? { min: Math.min(...sleepingCounts), max: Math.max(...sleepingCounts) } : null,
    orderedStateSha256: orderedState.digest('hex'), initializationMs: round(initializationMs), disposalMs: round(disposalMs),
    memory: { beforeInitialization, afterInitialization, afterDisposal },
    timingMs: Object.fromEntries(Object.entries(times).map(([key, value]) => [key, stats(value)])),
    frameBytes: Object.fromEntries(Object.entries(sizes).map(([key, value]) => [key, { samples: value,
      p50: percentile([...value].sort((a, b) => a - b), .5), p95: percentile([...value].sort((a, b) => a - b), .95),
      p99: percentile([...value].sort((a, b) => a - b), .99), max: Math.max(...value) }])) };
}

export async function main(argv = process.argv.slice(2)) {
  const chosen = options(argv), lock = await acquireMachineLock('bench', { pollMs: 100 });
  try {
    const files = ['tools/physics/integration-report.mjs', 'shared/simulation.ts', 'shared/simulation/phased.ts',
      'shared/simulation/content.ts', 'shared/simulation/physics-runtime.ts', 'shared/physics/world.ts',
      'shared/physics/constraints.ts', 'shared/simulation/hook.ts',
      'shared/simulation/dynamic-navigation.ts', 'shared/simulation/physics-presentation.ts',
      'shared/simulation/world-physics.ts', 'package.json', 'package-lock.json',
      'node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs',
      'node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm'];
    const hashes = {};
    for (const file of files) hashes[file] = sha(await readFile(file));
    const rapier = JSON.parse(await readFile('node_modules/@dimforge/rapier2d-compat/package.json', 'utf8'));
    const report = { schema: 'physics-p9-integration-1', date: new Date().toISOString(),
      provenance: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirtyTracked: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
        node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
        osRelease: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
        totalMemory: os.totalmem(), rapier: { version: rapier.version, license: rapier.license },
        lockPort: lock.port, hashes },
      workload: { seed: chosen.seed, warmup: chosen.warmup, samples: chosen.samples, tickMs: 50,
        map: 'synthetic open 17280x8640 room, 120-unit playable cells', layouts: ['sparse', 'clustered'],
        stages: { A: 'content-physics-2; no authored props', B: 'content-physics-8; warden roster',
          C: 'content-physics-8; hook roster and eight synthetic bounded ropes', legacy: 'content-5 control' },
        actors: [11, 27], cap: '128 total dynamic bodies including actors; cap rows use 64 solid crates and 53 or 37 sensor loot bodies',
        inputs: 'one accepted deterministic movement input per actor per tick; alternating magnitude-2 prop impulses keep props awake; bots disabled; damage set to zero' },
      targets: { stepP95Ms: 5, stepP99Ms: 10, wholeTickP99Ms: 25,
        interpretation: 'step() includes all simulation work, not isolated solver time; total is measured input + step + snapshot + one projection + two JSON serializations, excluding gzip' },
      limitations: ['Synthetic measured workload only; no production capacity or multiroom claim.',
        'Eight direct bounded ropes load the world constraint API; they do not establish eight successful hook interactions.',
        'Gzip size computation and byte sizing occur outside timing. Initialization/disposal timings and heap/RSS are noisy; forced GC is available only with --expose-gc.',
        'Finite-sample percentiles are descriptive. No browser frame impact, replay/privacy, feel, or full qualification gates are established here.'],
      rows: [], comparisons: [], failures: [] };
    const cases = [];
    for (const layout of ['sparse', 'clustered']) for (const actors of [11, 27]) {
      cases.push({ stage: 'legacy', actors, props: 0, loot: 0, layout }, { stage: 'A', actors, props: 0, loot: 0, layout },
        { stage: 'B', actors, props: 64, loot: 128 - actors - 64, layout },
        { stage: 'C', actors, props: 64, loot: 128 - actors - 64, layout });
    }
    for (const config of cases) try {
      const first = await runCase(config, chosen, 0), second = await runCase(config, chosen, 1);
      report.rows.push(first, second);
      const identical = first.orderedStateSha256 === second.orderedStateSha256;
      report.comparisons.push({ ...config, identicalOrderedState: identical, first: first.orderedStateSha256,
        second: second.orderedStateSha256 });
      if (!identical) report.failures.push({ ...config, reason: 'nondeterministic ordered state' });
    } catch (error) { report.failures.push({ ...config, reason: error?.stack ?? String(error) }); }
    await mkdir(dirname(chosen.output), { recursive: true });
    await writeFile(chosen.output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: chosen.output, rows: report.rows.length,
      deterministicComparisons: report.comparisons.length, failures: report.failures.length }));
    if (report.failures.length) throw new Error(`${report.failures.length} integration workload failures; see ${chosen.output}`);
    return report;
  } finally { lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
