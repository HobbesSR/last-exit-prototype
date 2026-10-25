import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRegion } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { rect } from '../shared/shape.ts';

const cli = (...args) => spawnSync(process.execPath, ['tools/micro-region.mjs', ...args], { encoding: 'utf8', maxBuffer: 4e6 });
test('CLI exports the same region result, checks its portals, and reports bounded seed batches', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'last-exit-micro-'));
  try {
    const file = path.join(dir, 'region.json');
    const made = cli('--type=depot', '--seed=81', `--out=${file}`);
    assert.equal(made.status, 0, made.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), buildRegion(regionExample({ type: 'depot', seed: 81 })));
    assert.equal(JSON.parse(cli(`--validate=${file}`).stdout).valid, true);
    // A wall across the whole region cuts the west portal off from the east one.
    const cut = JSON.parse(readFileSync(file, 'utf8'));
    cut.elements.push({ label: 'cut', x: 0, y: 0, template: { w: 960, h: 720, parts: [{ part: 'obstacle', kind: 'building', shape: rect(470, 0, 20, 720) }] } });
    writeFileSync(file, JSON.stringify(cut));
    const invalid = cli(`--validate=${file}`);
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stdout).errors.join(' '), /unreachable/);
    const brief = path.join(dir, 'brief.json');
    writeFileSync(brief, JSON.stringify(regionExample({ type: 'ruins', shape: 'hole', seed: 81 })));
    const batch = cli(`--brief=${brief}`, '--batch=3');
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(batch.stdout).runs.map(r => r.seed), [81, 82, 83]);
    assert.equal(cli('--batch=101').status, 1);
    assert.equal(cli('--unrecognized=true').status, 1);
    assert.equal(cli('--type=missing').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
