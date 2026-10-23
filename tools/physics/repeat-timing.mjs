// Focused sequential repetitions of #451's suspected contact-distance cost.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { benchmark } from './runner.mjs';
import { digest } from './common.mjs';

const output = process.argv[2] ?? 'test-results/physics-451-repeats.json';
const lock = await acquireMachineLock('bench');
try {
  const report = { date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, cpu: os.cpus()[0].model, os: os.release(), files: {}, rows: [] };
  for (const file of ['tools/physics/rapier.mjs', 'tools/physics/runner.mjs', 'tools/physics/scenarios.mjs',
    'tools/physics/repeat-timing.mjs', 'package-lock.json']) report.files[file] = await digest(await readFile(file, 'utf8'));
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const bodies of [128, 512]) {
      const config = { actors: 27, bodies, tethers: bodies === 128 ? 8 : 32, clustered: true, sleeping: 0, seed: 437 };
      const result = await benchmark('rapier', config, 4, { warmup: 20, samples: 100 });
      report.rows.push({ repetition, ...result });
      console.log(repetition, bodies, result.stepMs);
    }
  }
  await mkdir(new URL('../../test-results/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally { lock.release(); }
