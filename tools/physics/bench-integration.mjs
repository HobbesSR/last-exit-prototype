// Small whole-match integration sample, separate from qualification of the P9 envelope.
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { createGame, createPhysicsGame, step, snapshot, playerView, disposePhysics } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../../map/live.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';

const output = process.argv[2] ?? 'test-results/physics-438-integration.json';
const hash = data => createHash('sha256').update(data).digest('hex');
await acquireMachineLock('bench');
const content = contentById('content-3'), map = generateLiveMap(4217, content, DEFAULT_LIVE_ZONE_SIZE);
const rows = [];
for (const mode of ['legacy', 'physics']) {
  const arena = structuredClone(map);
  for (const tiles of prebuiltTiles(arena, content)) adoptPackedTiles(arena, tiles);
  const s = mode === 'physics' ? await createPhysicsGame(4217, arena, content) : createGame(4217, arena, content);
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
    rows.push({ mode, version: s.version, warmup: 100, ticks: s.tick, samplesMs: samples,
      p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1),
      maxFrameBytes: Math.max(...sizes), frameBytes: sizes });
  } finally { disposePhysics(s); }
}
const sources = {};
for (const file of ['shared/simulation/phased.ts', 'shared/physics/world.ts', 'shared/simulation/physics-projectiles.ts', 'tools/physics/bench-integration.mjs']) sources[file] = hash(await readFile(file));
const report = { schema: 'physics-438-integration-1', baseCommit: 'd668586', node: process.version,
  machine: { cpu: cpus()[0]?.model, platform: platform(), release: release() },
  fixture: { seed: 4217, content: content.id, size: '12x6', actors: 11, warmup: 100, samples: 500,
    mapSha256: hash(JSON.stringify(map)), obstacles: map.obstacles.length, gates: map.gates.length,
    workload: 'bot match step + authoritative snapshot + one player projection; frame sizing outside timed interval' },
  sources, rows, limitation: 'Single seeded short whole-match sample; no capacity, privacy or feel promotion. P9 still owns qualification.' };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report) + '\n');
console.log(JSON.stringify({ output, rows: rows.map(({ mode, p95, p99, maxFrameBytes }) => ({ mode, p95, p99, maxFrameBytes })) }));
