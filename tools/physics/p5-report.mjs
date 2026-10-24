// Synthetic P5 body-heavy simulation/projection report; this does not qualify whole-room capacity.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { createPhysicsGame, disposePhysics, playerView, snapshot, step, synchronizePhysics } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { physicsRuntime } from '../../shared/simulation/physics-runtime.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const warmup = Number(args.get('warmup') ?? 40), samples = Number(args.get('samples') ?? 200);
if (!Number.isSafeInteger(warmup) || warmup < 0 || !Number.isSafeInteger(samples) || samples < 1)
  throw new Error('Use nonnegative --warmup=N and positive --samples=N integers');

const lock = await acquireMachineLock('bench', { pollMs: 100 });
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(6));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const summarize = values => ({ samplesMs: values.map(round), p50: round(percentile(values, .50)),
  p95: round(percentile(values, .95)), p99: round(percentile(values, .99)), max: round(Math.max(...values)) });
const summarizeCounts = values => ({ p50: percentile(values, .50), min: Math.min(...values), max: Math.max(...values),
  mean: round(values.reduce((a, b) => a + b, 0) / values.length) });
const memory = () => ({ ...process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024 });
const seed = 445;

function arena(lootCount, clustered, withProp) {
  const width = 2400, height = 1200;
  const rows = Array.from({ length: height / 100 }, (_, y) => ({ y, runs: [[0, width / 100]] }));
  const items = Array.from({ length: lootCount }, (_, i) => {
    const x = clustered ? 1000 + (i % 13) * 10 : 700 + (i % 20) * 55;
    const y = clustered ? 600 + Math.floor(i / 13) * 10 : 100 + Math.floor(i / 20) * 55;
    return { id: `p5-cell-${i.toString().padStart(3, '0')}`, kind: 'cell', x, y, charge: 100 };
  });
  return {
    seed, width, height,
    playableArea: { cellSize: 100, rows },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 60, y: 600 }, exit: { x: 2300, y: 600 },
    spawns: Array.from({ length: 8 }, (_, i) => ({ x: 100 + i * 52, y: 200 })),
    hunterSpawns: Array.from({ length: 3 }, (_, i) => ({ x: 2240 - i * 52, y: 1000 })),
    physicsProps: withProp ? [{ id: 'report-crate', profile: 'crate', x: 1800, y: 600 }] : [],
  };
}

async function runCase({ lootCount, clustered, withProp, awake }) {
  const map = arena(lootCount, clustered, withProp);
  const mapSha256 = hash(JSON.stringify(map));
  const content = structuredClone(contentById('content-physics-5'));
  content.roster = { contestants: Array.from({ length: 8 }, (_, i) => `C${i}`),
    gladiators: Array.from({ length: 3 }, (_, i) => ({ name: `G${i}`, kit: 'warden' })) };
  const initStarted = performance.now();
  const game = await createPhysicsGame(seed, map, content);
  const initializationMs = performance.now() - initStarted;
  const runtime = physicsRuntime(game);
  if (!runtime) throw new Error('P5 runtime missing');
  for (const player of game.players) player.bot = false;
  synchronizePhysics(game);
  const affectedBodyIds = runtime.world.snapshot({ includeStatic: false }).bodies
    .filter(body => body.spec.kind === 'prop').map(body => body.spec.id);

  const impulsePreparationMs = [], stepMs = [], snapshotMs = [], projectionMs = [], serializationMs = [];
  const frameBytes = [], sleepingCounts = [], awakeCounts = [];
  const measuredAt = index => index >= warmup;
  let latestSettings, lastState, lastSleeping = 0, lastAwake = 0, disposalMs = 0;
  try {
    for (let tick = 0; tick < warmup + samples; tick++) {
      const prepStarted = performance.now();
      if (awake) {
        // Queue directly on the world before timing step(); alternating small impulses prevent
        // settling while keeping net motion bounded. Preparation is reported separately.
        const sign = tick % 2 === 0 ? 1 : -1;
        for (const id of affectedBodyIds) runtime.world.queueImpulse(id, { x: sign * 2, y: 0 });
      }
      const elapsedPreparation = performance.now() - prepStarted;
      const startStep = performance.now();
      step(game);
      const elapsedStep = performance.now() - startStep;
      const startSnapshot = performance.now();
      const state = snapshot(game);
      const elapsedSnapshot = performance.now() - startSnapshot;
      const viewer = game.players.find(player => player.role === 'contestant');
      const startProjection = performance.now();
      const view = playerView(game, state, viewer.id);
      const elapsedProjection = performance.now() - startProjection;
      const startSerialization = performance.now();
      const text = JSON.stringify({ state, view });
      const elapsedSerialization = performance.now() - startSerialization;
      latestSettings = state.physics.settings;
      lastState = state;
      if (measuredAt(tick)) {
        if (awake) impulsePreparationMs.push(elapsedPreparation);
        stepMs.push(elapsedStep); snapshotMs.push(elapsedSnapshot);
        projectionMs.push(elapsedProjection); serializationMs.push(elapsedSerialization);
        frameBytes.push(Buffer.byteLength(text));
        const bodies = state.physics.world.bodies;
        sleepingCounts.push(bodies.filter(body => body.transform.sleeping).length);
        awakeCounts.push(bodies.length - sleepingCounts.at(-1));
        lastSleeping = sleepingCounts.at(-1);
        lastAwake = awakeCounts.at(-1);
      }
      if (game.phase !== 'live') throw new Error(`Match ended unexpectedly at tick ${game.tick}`);
    }
  } finally {
    const disposeStarted = performance.now();
    disposePhysics(game);
    disposalMs = performance.now() - disposeStarted;
  }
  const actualBodies = lastState.physics.world.bodies.length;
  const expectedBodies = 11 + lootCount + (withProp ? 1 : 0);
  if (actualBodies !== expectedBodies) throw new Error(`Expected ${expectedBodies} dynamic bodies, observed ${actualBodies}`);
  return {
      layout: clustered ? 'clustered' : 'sparse', bodyCondition: awake ? 'awake' : 'settling-sleep',
      loot: lootCount, authoredProps: withProp ? 1 : 0,
      awakeStimulus: awake ? { affectedBodyCount: affectedBodyIds.length, impulsesPerTick: affectedBodyIds.length,
        impulseXAlternates: [-2, 2], preparationOutsideStepTiming: true } : null,
      dynamicBodyCount: actualBodies, warmup, samples,
      ticks: game.tick, phase: game.phase, initializationMs: round(initializationMs), disposalMs: round(disposalMs),
      map: { width: map.width, height: map.height, playableCellSize: map.playableArea.cellSize,
        playableRows: map.playableArea.rows.length, obstacles: map.obstacles.length, gates: map.gates.length, sha256: mapSha256 },
      settings: latestSettings, timing: { impulsePreparation: awake ? summarize(impulsePreparationMs) : null,
        impulsePreparationIncludedInStep: false, step: summarize(stepMs), snapshot: summarize(snapshotMs),
        projection: summarize(projectionMs), serialization: summarize(serializationMs) },
      frameBytes: { samples: frameBytes, mean: round(frameBytes.reduce((a, b) => a + b, 0) / frameBytes.length),
        min: Math.min(...frameBytes), max: Math.max(...frameBytes) },
      bodyState: { sleeping: summarizeCounts(sleepingCounts), awake: summarizeCounts(awakeCounts),
        lastSleeping, lastAwake },
    };
}

const report = {
  schema: 'physics-445-p5-report-1',
  date: new Date().toISOString(),
  command: process.argv.slice(2),
  provenance: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirtyTracked: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    os: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(),
    lockPort: lock.port, seed, warmup, samples, packageName: JSON.parse(await readFile('package.json', 'utf8')).name,
    hashes: {},
  },
  pinnedContent: { ...contentById('content-physics-5'), roster: {
    contestants: Array.from({ length: 8 }, (_, i) => `C${i}`),
    gladiators: Array.from({ length: 3 }, (_, i) => ({ name: `G${i}`, kit: 'warden' })),
  } },
  scenarios: [],
  memoryBefore: memory(),
  limitations: [
    'Synthetic authored map and stationary 11-actor roster; not a whole-room or production capacity qualification.',
    'Loot is kept away from all actor spawn points; the one crate is inert and is not a damage or blast-cover witness.',
    'Each metric times only its named synchronous operation; serialization covers JSON.stringify({state, view}) and byte sizing is outside the timed interval.',
    'Finite-sample p99 is descriptive, not a tail-latency guarantee. Memory includes JS and WASM wrappers and runtime noise.',
  ],
};

try {
  const files = ['tools/physics/p5-report.mjs', 'shared/physics/world.ts', 'shared/simulation/phased.ts',
    'shared/physics/types.ts', 'shared/simulation/physics-runtime.ts', 'shared/traps.ts',
    'shared/simulation/explosion-physics.ts', 'shared/simulation/actor-physics.ts', 'shared/simulation.ts',
    'shared/simulation/world-physics.ts', 'shared/simulation/physics-presentation.ts', 'shared/simulation/visibility.ts',
    'shared/simulation/content.ts', 'shared/simulation/loot.ts', 'shared/simulation/interactions.ts', 'shared/equipment.ts', 'shared/item-instances.ts',
    'server/match.js', 'tests/bench.mjs', 'tests/bench-client.mjs', 'shared/types.ts', 'package.json', 'package-lock.json',
    'node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs', 'node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm'];
  for (const file of files) report.provenance.hashes[file] = hash(await readFile(file));
  const rapierPackage = JSON.parse(await readFile('node_modules/@dimforge/rapier2d-compat/package.json', 'utf8'));
  report.provenance.rapier = { name: rapierPackage.name, version: rapierPackage.version, license: rapierPackage.license };
  report.workload = { actors: 11, lootCounts: [0, 64, 117], additionalPropCase: '116 loot + 1 inert crate; total dynamic capacity 128 including actors',
    layouts: ['sparse', 'clustered'], bodyConditions: ['settling-sleep', 'awake'],
    awakeMethod: 'Outside each timed step, queue alternating +/-2 world-unit x impulses to every item/prop body; actors receive none.' };
  for (const clustered of [false, true]) {
    for (const lootCount of [0, 64, 117]) {
      for (const awake of [false, true])
        report.scenarios.push(await runCase({ lootCount, clustered, withProp: false, awake }));
      if (lootCount === 117) for (const awake of [false, true])
        report.scenarios.push(await runCase({ lootCount: 116, clustered, withProp: true, awake }));
    }
  }
  report.memoryAfter = memory();
  console.log(JSON.stringify(report, null, 2));
} finally {
  lock.release();
}
