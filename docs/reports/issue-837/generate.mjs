import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { generate } from '../../../map/chain.ts';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';

const lock = await acquireMachineLock('bench');
try {
  const params = { mode: 'game', zoneWidth: 36, zoneHeight: 18 };
  const start = performance.now();
  const map = generate('size-36-1', params);
  const generateMs = performance.now() - start;
  const report = JSON.stringify({ checkpoint: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, seed: 'size-36-1', params, cellSize: map.cellSize, generateMs,
    sha256: createHash('sha256').update(JSON.stringify(map)).digest('hex'),
    note: 'SDK expansion switched off; one cold whole-map sample, not an adoption-cost estimate.' }, null, 2) + '\n';
  if (process.argv[2]) writeFileSync(process.argv[2], report);
  else console.log(report);
} finally { lock.release(); }
