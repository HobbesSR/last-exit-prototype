import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateMicroRegion } from '../shared/map/micro/index.ts';
import { microExample } from '../shared/map/micro/examples.ts';

const cli = (...args) => spawnSync(process.execPath, ['tools/micro-region.mjs', ...args], { encoding: 'utf8', maxBuffer: 4e6 });
test('CLI exports the same core artifact, validates files, and reports bounded seed batches', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'last-exit-micro-'));
  try {
    const file = path.join(dir, 'region.json');
    const made = cli('--builder=depot', '--seed=81', `--out=${file}`);
    assert.equal(made.status, 0, made.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), generateMicroRegion(microExample('depot', 81)));
    assert.equal(JSON.parse(cli(`--validate=${file}`).stdout).valid, true);
    const bad = JSON.parse(readFileSync(file, 'utf8')); bad.version = 'unknown'; writeFileSync(file, JSON.stringify(bad));
    assert.equal(cli(`--validate=${file}`).status, 1);
    const batch = cli('--builder=ruins', '--shape=hole', '--seed=81', '--batch=3');
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(batch.stdout).runs.map(r => r.seed), [81, 82, 83]);
    assert.equal(cli('--batch=101').status, 1);
    assert.equal(cli('--unrecognized=true').status, 1);
    const entry = cli('--builder=entry', '--profile=cell', '--count=24');
    assert.equal(entry.status, 0, entry.stderr);
    assert.equal(JSON.parse(entry.stdout).entry.points.length, 24);
    assert.equal(JSON.parse(entry.stdout).spec.bodyProfile, 'cell');
    assert.equal(cli('--builder=entry', '--count=65').status, 1);
    assert.equal(cli('--profile=unknown').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
