// Diagnose every map whose built geometry changed in the full #533 sweep.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isMainThread, parentPort } from 'node:worker_threads';
import { runPool } from '../map/tools/sweep.mts';
import { generate, checkMap } from '../map/tools/core.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';

if (!isMainThread) {
  parentPort.on('message', unit => {
    try {
      const checked = checkMap(generate(unit.seed, unit.params), { diagnose: true });
      parentPort.postMessage({ key: unit.key, valid: checked.valid, defects: checked.defects,
        brokenPromises: checked.brokenPromises });
    } catch (error) {
      parentPort.postMessage({ key: unit.key, valid: false, error: String(error.stack ?? error) });
    }
  });
} else {
  const sweepPath = process.argv[2] ?? 'test-results/533-sweep-before.json';
  const output = process.argv[3] ?? 'docs/reports/issue-533/integration.json';
  const bytes = fs.readFileSync(sweepPath);
  const sweep = JSON.parse(bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
  const baseline = JSON.parse(fs.readFileSync('map/tools/fixtures/chain-baseline.json'));
  const wanted = new Set(sweep.drift.filter(d => d.views.includes('built')).map(d => d.key));
  const units = baseline.provenance.cases.flatMap(c => Array.from({ length: c.count }, (_, i) => ({
    key: `${c.id}/${c.seedPrefix}-${i + 1}`, seed: `${c.seedPrefix}-${i + 1}`, params: c.params,
  }))).filter(u => wanted.has(u.key));
  if (units.length !== wanted.size) throw Error('Drift keys do not match baseline provenance');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const hash = b => createHash('sha256').update(b).digest('hex');
  const paths = git('ls-files', 'map/micro', 'map/kernel', 'map/macro/src', 'shared').split(/\r?\n/).filter(p => /\.ts$/.test(p));
  const hashes = () => Object.fromEntries(paths.map(p => [p, hash(fs.readFileSync(p))]));
  const before = hashes(), start = performance.now();
  const results = await runPool(new URL(import.meta.url), units, 8);
  if (JSON.stringify(hashes()) !== JSON.stringify(before)) throw Error('Source changed during diagnostics');
  const driftCounts = {};
  for (const d of sweep.drift) for (const view of d.views) driftCounts[view] = (driftCounts[view] ?? 0) + 1;
  const report = { commit: git('rev-parse', 'HEAD'), trackedDirty: git('status', '--porcelain', '--untracked-files=no'),
    sourceHashes: before, node: process.version, regionTypesVersion: REGION_TYPES_VERSION,
    sweepPath, sweepSha256: hash(bytes), sweepChecked: sweep.checked, driftCounts,
    diagnostic: 'checkMap(generate(seed, params), { diagnose: true }) on every built-drift map',
    seconds: (performance.now() - start) / 1000, checked: results.length, failures: results.filter(r => !r.valid), results };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checked: report.checked, seconds: report.seconds, driftCounts, failures: report.failures }));
  process.exitCode = report.failures.length ? 1 : 0;
}
