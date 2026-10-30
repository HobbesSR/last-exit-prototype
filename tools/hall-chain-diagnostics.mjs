// Reproduce #533's whole-map diagnostics for every built-drift map in a sweep check.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isMainThread, parentPort } from 'node:worker_threads';
import { generate, checkMap } from '../map/tools/core.ts';
import { runPool, sweepUnits, unitKey, unitSeed } from '../map/tools/sweep.mts';

if (!isMainThread) {
  parentPort.on('message', unit => {
    const checked = checkMap(generate(unitSeed(unit), unit.params), { diagnose: true });
    parentPort.postMessage({ key: unitKey(unit), valid: checked.valid,
      defects: checked.defects, brokenPromises: checked.brokenPromises });
  });
} else {
  const input = process.argv[2] ?? 'docs/reports/issue-533-hall/sweep-before.json';
  const output = process.argv[3] ?? 'docs/reports/issue-533-hall/integration.json';
  const sweepBytes = await readFile(input), sweep = JSON.parse(sweepBytes.toString());
  const baseline = JSON.parse(await readFile('map/tools/fixtures/chain-baseline.json', 'utf8'));
  const keys = new Set(sweep.drift.filter(d => d.views.includes('built')).map(d => d.key));
  const units = sweepUnits(baseline.provenance.cases).filter(unit => keys.has(unitKey(unit)));
  assert.equal(units.length, keys.size, 'Unknown drift case');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const paths = git('ls-files', 'map/macro/src', 'map/macro/content', 'map/micro',
    'map/kernel', 'map/chain.ts', 'map/engines.ts', 'shared').split(/\r?\n/).filter(p => /\.(ts|json)$/.test(p));
  const inventory = async () => Object.fromEntries(await Promise.all(paths.map(async p =>
    [p, hash((await readFile(p, 'utf8')).replaceAll('\r\n', '\n'))])));
  const sources = await inventory(), started = performance.now();
  console.log(`Diagnosing ${units.length} built-drift maps`);
  const rows = await runPool(new URL(import.meta.url), units, 4);
  assert.deepEqual(await inventory(), sources, 'Inputs changed during diagnostics');
  await writeFile(output, JSON.stringify({ commit: git('rev-parse', 'HEAD'),
    trackedDirty: git('status', '--porcelain', '--untracked-files=no'), node: process.version,
    sweepSha256: hash(sweepBytes), sourceHashes: sources,
    seconds: (performance.now() - started) / 1000, rows }, null, 2) + '\n');
  assert.deepEqual(rows.filter(r => !r.valid), [], 'Whole-map defects or broken promises');
  console.log(`All ${rows.length} maps pass final-geometry diagnostics`);
}
