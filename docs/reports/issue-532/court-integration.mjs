import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isMainThread, parentPort } from 'node:worker_threads';
import { runPool } from '../../../map/tools/sweep.mts';
import { generate, checkMap } from '../../../map/tools/core.ts';
import { REGION_TYPES_VERSION } from '../../../map/micro/region-types.ts';

if (!isMainThread) {
  parentPort.on('message', unit => {
    const start = performance.now();
    try {
      const checked = checkMap(generate(unit.seed, unit.params), { diagnose: true });
      parentPort.postMessage({ key: unit.key, valid: checked.valid, defects: checked.defects,
        brokenPromises: checked.brokenPromises, seconds: Math.round((performance.now() - start) / 1000) });
    } catch (error) {
      parentPort.postMessage({ key: unit.key, valid: false, error: String(error.stack ?? error) });
    }
  });
} else {
  const root = new URL('../../../', import.meta.url);
  const log = fs.readFileSync(new URL('../../../test-results/532-sweep-before.log', import.meta.url));
  const sweep = JSON.parse(log.toString(log[0] === 255 && log[1] === 254 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
  const cases = JSON.parse(fs.readFileSync(new URL('../../../map/tools/fixtures/chain-baseline.json', import.meta.url))).provenance.cases;
  const wanted = new Set(sweep.drift.filter(d => d.views.includes('built')).map(d => d.key));
  const units = cases.flatMap(c => Array.from({ length: c.count }, (_, i) => ({
    key: `${c.id}/${c.seedPrefix}-${i + 1}`, seed: `${c.seedPrefix}-${i + 1}`, params: c.params,
  }))).filter(u => wanted.has(u.key));
  if (units.length !== wanted.size) throw new Error('Built-drift keys do not all match baseline case provenance');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const dirty = git('status', '--porcelain', '--', 'map/micro', 'map/kernel', 'map/macro/src', 'map/macro/content', 'map/chain.ts', 'map/engines.ts', 'shared');
  const hashes = Object.fromEntries(['map/micro/strategies/compound.ts', 'map/micro/strategies/compound-court.ts', 'map/micro/region-types.ts']
    .map(path => [path, createHash('sha256').update(fs.readFileSync(new URL(`../../../${path}`, import.meta.url))).digest('hex')]));
  const driftCounts = {};
  for (const item of sweep.drift) for (const view of item.views) driftCounts[view] = (driftCounts[view] ?? 0) + 1;
  const start = performance.now(), results = await runPool(new URL(import.meta.url), units, 8);
  const report = { sourceHead: git('rev-parse', 'HEAD'), node: process.version, regionTypesVersion: REGION_TYPES_VERSION,
    sourceNote: 'Diagnostics used dirty working content, not HEAD alone; selected file hashes and input status are recorded below.',
    dirtyInputs: dirty.split('\n').filter(Boolean), selectedFileSha256: hashes,
    sweepSource: 'test-results/532-sweep-before.log', sweepSha256: createHash('sha256').update(log).digest('hex'),
    baseline: 'map/tools/fixtures/chain-baseline.json', sweepChecked: sweep.checked, driftCounts,
    diagnostic: 'checkMap(generate(seed, params), { diagnose: true }) for all built-drift keys',
    checked: results.length, seconds: Math.round((performance.now() - start) / 1000),
    failures: results.filter(r => !r.valid), results };
  fs.writeFileSync(new URL('./court-integration.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checked: report.checked, seconds: report.seconds, driftCounts, failures: report.failures }));
  process.exitCode = report.failures.length ? 1 : 0;
}
