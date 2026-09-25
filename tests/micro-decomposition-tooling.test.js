import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decompositionExample, planExample } from '../shared/map/micro/decomposition/example.ts';

const cli = (...args) => spawnSync(process.execPath, ['tools/decompose-region.mjs', ...args], { encoding: 'utf8', maxBuffer: 8e6 });
test('decomposition CLI shares the strategy, validates artifacts, and refuses ambiguous options', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'last-exit-decomposition-'));
  try {
    const file = path.join(dir, 'plan.json'), spec = path.join(dir, 'context.json');
    const made = cli('--shape=ring', '--beam=4', `--out=${file}`);
    assert.equal(made.status, 0, made.stderr);
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(plan, JSON.parse(JSON.stringify(planExample(decompositionExample('ring'), { beamWidth: 4 }))));
    assert.equal(JSON.parse(cli(`--validate=${file}`).stdout).valid, true);
    plan.residuals.push({ id: 'invalid', role: 'residual', cells: [plan.context.cells[0]] });
    writeFileSync(file, JSON.stringify(plan));
    assert.equal(cli(`--validate=${file}`).status, 1);
    writeFileSync(spec, JSON.stringify({ ...decompositionExample('l'), id: 'custom' }));
    const custom = cli(`--spec=${spec}`, '--piece-penalty=50');
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(JSON.parse(custom.stdout).context.id, 'custom');
    assert.equal(cli('--beam=33').status, 1);
    assert.equal(cli('--shape=ring', '--shape=neck').status, 1);
    assert.equal(cli(`--validate=${file}`, '--shape=neck').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
