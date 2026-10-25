// Sequential crowd comparison, intentionally separate from ordinary test runs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { createPhysicsGame, disposePhysics, step, snapshot, playerView } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { dynamicNavigationWork } from '../../shared/simulation/dynamic-navigation.ts';

const output = process.argv[2] ?? 'test-results/physics-p8-crowd.json';
await acquireMachineLock('bench');
const rows = [];
for (let repeat = 0; repeat < 3; repeat++) for (const id of ['content-physics-6', 'content-physics-8']) {
  const content = structuredClone(contentById(id));
  content.discovery = false;
  content.roster = { contestants: Array.from({ length: 24 }, (_, i) => `C${i}`),
    gladiators: Array.from({ length: 3 }, (_, i) => ({ name: `G${i}`, kit: 'warden' })) };
  for (const weapon of Object.values(content.weapons)) weapon.damage = 0;
  for (const kit of Object.values(content.kits)) kit.damage = 0;
  const map = { seed: 448, width: 2000, height: 1200,
    playableArea: { cellSize: 100, rows: Array.from({ length: 12 }, (_, y) => ({ y, runs: [[0, 20]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [],
    items: Array.from({ length: 37 }, (_, i) => ({ id: `loot-${i}`, kind: 'med', count: 1, x: 200 + i % 8 * 20, y: 200 + Math.floor(i / 8) * 20 })),
    traps: [], routes: [], nodes: [], streets: [],
    physicsProps: Array.from({ length: 64 }, (_, i) => ({ id: `crate-${i}`, profile: 'crate',
      x: 1000 + i % 8 * 70, y: 280 + Math.floor(i / 8) * 70, angle: i % 2 * Math.PI / 5 })),
    entry: { x: 100, y: 600 }, exit: { x: 1800, y: 600 },
    spawns: Array.from({ length: 24 }, (_, i) => ({ x: 600 + i % 6 * 36, y: 480 + Math.floor(i / 6) * 36 })),
    hunterSpawns: Array.from({ length: 3 }, (_, i) => ({ x: 850, y: 480 + i * 50 })) };
  const game = await createPhysicsGame(448, map, content), samples = [];
  let peakEdges = 0;
  try {
    const initialBodies = snapshot(game).physics.world.bodies.length;
    if (initialBodies !== 128) throw new Error(`expected 128 admitted bodies, got ${initialBodies}`);
    for (let tick = 0; tick < 500; tick++) {
      if (game.phase !== 'live') throw new Error('crowd fixture ended early');
      const before = performance.now();
      step(game); const frame = snapshot(game); playerView(game, frame, game.players[0].id);
      const elapsed = performance.now() - before;
      peakEdges = Math.max(peakEdges, dynamicNavigationWork(game));
      if (tick >= 100) samples.push(elapsed);
    }
    const sorted = [...samples].sort((a, b) => a - b), at = q => sorted[Math.floor(q * sorted.length)];
    rows.push({ repeat, content: id, initialBodies, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1), peakEdges, samplesMs: samples });
  } finally { disposePhysics(game); }
}
const sources = {};
for (const file of ['shared/simulation/dynamic-navigation.ts', 'shared/simulation/bots.ts', 'shared/simulation/phased.ts',
  'shared/simulation.ts', 'shared/physics/world.ts', 'shared/simulation/content.ts', 'tools/physics/navigation-report.mjs'])
  sources[file] = createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ schema: 'physics-p8-crowd-1', node: process.version, cpu: cpus()[0]?.model,
  platform: platform(), release: release(), createdAt: new Date().toISOString(),
  workload: '27 bots, 64 crates, 37 sensor loot; 100 warmup + 400 samples; step + snapshot + one projection; three sequential paired runs',
  limitation: 'Synthetic crowd smoke cost, not P9 capacity qualification or evidence fixing the historical slowdown.', sources, rows }) + '\n');
console.log(JSON.stringify({ output, rows: rows.map(({ samplesMs, ...row }) => row) }));
