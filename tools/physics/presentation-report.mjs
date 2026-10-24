// Synthetic body-heavy transport/recording workload, not a whole-room capacity qualification.
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReplayWriter } from '../../server/replay-writer.js';
import { createLayerEncoder } from '../../shared/frame-layers.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { SCHEMA } from '../../shared/recording.ts';

await acquireMachineLock('bench');
const out = process.argv[2] ?? 'test-results/physics-440-serialization.json';
const samples = 200, samplesMs = [], bodies = Array.from({ length: 128 }, (_, i) => ({
  id: `prop:${i}`, kind: 'prop', shape: { kind: 'box', hx: 8, hy: 12 }, generation: 1,
  x: i * 20, y: 200, angle: 0, vx: 60, vy: 0, omega: .5, sleeping: false,
}));
const tethers = Array.from({ length: 8 }, (_, i) => ({ id: `rope:${i}`, a: bodies[i * 2].id, b: bodies[i * 2 + 1].id }));
const encoder = createLayerEncoder(), chunks = [];
const held = {};
const writer = createReplayWriter({ header: { id: 'physics-440', schema: SCHEMA, minSchema: 10, map: { obstacles: [] } },
  output: new Writable({ write(chunk, _enc, next) { chunks.push(Buffer.from(chunk)); next(); } }), publish: async () => {} });
let plainBytes = 0, wireBytes = 0, peakPendingBytes = 0;
const digest = createHash('sha256');
for (let tick = 0; tick < samples; tick++) {
  const projected = { tick, physicsProfile: 'last-exit-0.8-physics-2', bodies: bodies.map(b => ({ ...b, x: b.x + tick * 3, angle: tick * .025 })), tethers };
  const frame = { ...projected, physics: { profile: projected.physicsProfile,
    settings: { engine: 'synthetic', version: 'transport-only', unitsPerMetre: 40, substeps: 4, substepSeconds: .0125,
      speculativeDistanceMetres: .6, exactCheckpoint: 'unsupported', maxConstraints: 8, constraintLimitations: 'synthetic transport workload' },
    world: { bodies: projected.bodies.map(({ id, kind, shape, generation, ...transform }) => ({ spec: { id, kind, shape, x: transform.x, y: transform.y }, transform, generation })),
      constraints: tethers.map(t => ({ ...t, maxDistance: 40 })),
      pending: { add: [], remove: [], addConstraints: [], removeConstraints: [], forces: [], impulses: [] } },
    pendingSpawns: [], pendingImpulses: [], pendingAttachments: [] } };
  const before = performance.now();
  const encoded = encoder.encode(projected), wire = { ...projected };
  for (const [layer, e] of Object.entries(encoded)) {
    wire[layer] = 'plain' in e ? e.plain : held[layer] === e.k ? e.changes : e.all();
    if ('k' in e) held[layer] = e.k;
  }
  const plain = JSON.stringify({ state: frame, commands: [] });
  plainBytes += Buffer.byteLength(plain); wireBytes += Buffer.byteLength(JSON.stringify(wire));
  if (!writer.append(frame, [])) throw Error('Unexpected omission in paced serialization workload');
  digest.update(plain + '\n');
  samplesMs.push(performance.now() - before);
  peakPendingBytes = Math.max(peakPendingBytes, writer.pendingBytes);
  // Drain between samples; unpaced backpressure/whole-frame omission is tested separately.
  while (writer.pendingBytes) await new Promise(resolve => setImmediate(resolve));
}
const meta = await writer.finish({ ticks: samples - 1 });
if (meta.sha256 !== digest.digest('hex')) throw Error('Retained-frame digest mismatch');
samplesMs.sort((a,b) => a-b);
const files = {};
for (const file of ['tools/physics/presentation-report.mjs', 'shared/frame-layers.ts', 'server/replay-writer.js']) {
  files[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const report = { date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
  files,
  workload: { samples, dynamicBodies: 128, tethers: 8, moving: true, privateGameplayState: true },
  serializationMs: { mean: samplesMs.reduce((a,b)=>a+b,0)/samples, p95: samplesMs[Math.floor(samples*.95)], max: samplesMs.at(-1) },
  plainBytes, wireBytes, peakPendingBytes, gzipBytes: Buffer.concat(chunks).length, droppedFrames: writer.droppedFrames, sha256: meta.sha256,
  limitations: ['Synthetic transport includes private gameplay-state duplication for recording, but excludes simulation, map and player payloads.', 'Layer encoding, JSON serialization and writer append CPU measured together; gzip drains outside the timed interval.', 'No production throughput or tail-latency guarantee.'] };
await mkdir(new URL('../../test-results/', import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
