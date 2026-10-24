// Small whole-match integration sample, separate from qualification of the P9 envelope.
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { createPhysicsGame, step, snapshot, playerView, disposePhysics } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../../map/live.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';

const output = process.argv[2] ?? 'test-results/physics-439-integration.json';
const hash = data => createHash('sha256').update(data).digest('hex');
await acquireMachineLock('bench', { pollMs: 100 });
const content = contentById('content-4'), map = generateLiveMap(4217, content, DEFAULT_LIVE_ZONE_SIZE);
const rows = [];
for (const mode of ['P1', 'P2']) {
  const tuning = mode === 'P2' ? contentById('content-physics-2') : content;
  const arena = structuredClone(map);
  for (const tiles of prebuiltTiles(arena, content)) adoptPackedTiles(arena, tiles);
  const s = await createPhysicsGame(4217, arena, tuning);
  try {
    const samples = [], sizes = [];
    for (let tick = 0; tick < 600 && s.phase === 'live'; tick++) {
      const before = performance.now();
      step(s); const state = snapshot(s); playerView(s, state, s.players[0].id);
      const elapsed = performance.now() - before;
      if (tick >= 100) { samples.push(elapsed); sizes.push(Buffer.byteLength(JSON.stringify(state))); }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    rows.push({ mode, content: s.content.id, version: s.version, profile: tuning.actorPhysics ?? null,
      settings: snapshot(s).physics.settings, warmup: 100, ticks: s.tick, samplesMs: samples,
      p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1),
      maxFrameBytes: Math.max(...sizes), frameBytes: sizes });
  } finally { disposePhysics(s); }
}
const sources = {};
for (const file of ['shared/simulation/phased.ts', 'shared/physics/world.ts', 'shared/simulation/physics-projectiles.ts', 'tools/physics/bench-characters.mjs', 'shared/simulation/actor-physics.ts', 'shared/simulation/content.ts']) sources[file] = hash(await readFile(file));
const report = { schema: 'physics-439-integration-1', baseCommit: 'fe37e5d', node: process.version,
  machine: { cpu: cpus()[0]?.model, platform: platform(), release: release() },
  fixture: { seed: 4217, content: content.id, size: '12x6', actors: 11, warmup: 100, samples: 500,
    mapSha256: hash(JSON.stringify(map)), obstacles: map.obstacles.length, gates: map.gates.length,
    workload: 'bot match step + authoritative snapshot + one player projection; frame sizing outside timed interval' },
  sources, rows, limitation: 'Single seeded short whole-match sample; no capacity, privacy or feel promotion. P9 still owns qualification.' };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report) + '\n');
console.log(JSON.stringify({ output, rows: rows.map(({ mode, p95, p99, maxFrameBytes }) => ({ mode, p95, p99, maxFrameBytes })) }));
