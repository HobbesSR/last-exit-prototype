// Run only while no tests, sweeps or benchmarks compete for CPU.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRegion } from '../../../map/micro/region-types.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const baselineBytes = readFileSync(new URL('./before.json.gz', import.meta.url));
const baseline = JSON.parse(gunzipSync(baselineBytes));
const report = JSON.parse(readFileSync(new URL('./after.json', import.meta.url)));
const original = pathToFileURL(resolve('map/micro/strategies/compound.ts'));
const source = execFileSync('git', ['show', `${report.baseCommit}:map/micro/strategies/compound.ts`], { encoding: 'utf8' });
const rewritten = source.replace(/from '([^']+)'/g, (_, spec) => `from '${new URL(spec, original).href}'`);
const folder = mkdtempSync(resolve('test-results/issue-532-exterior-control-'));
const file = resolve(folder, 'control.ts');
writeFileSync(file, rewritten);
try {
  const { buildCompound } = await import(pathToFileURL(file).href);
  const all = baseline.samples.flatMap(s => s.compounds);
  const ids = ['compound@246,228', 'compound@348,162', 'compound@252,186'];
  const cases = ids.map(id => all.find(c => c.id === id));
  assert.ok(cases.every(Boolean));
  const expected = report.samples.flatMap(s => s.rows);
  const rows = [];
  for (const c of cases) {
    const run = mode => {
      const started = performance.now();
      const output = mode === 'before' ? buildRegion(c.brief, { compound: buildCompound }) : buildRegion(c.brief);
      const ms = performance.now() - started;
      assert.equal(hash(JSON.stringify(output)), mode === 'before'
        ? hash(JSON.stringify(c.baseline)) : expected.find(r => r.id === c.id).afterHash);
      return ms;
    };
    run('before'); run('after'); // Warm each implementation; retain every measured repeat.
    const trials = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      let before, after;
      if (repeat % 2) { after = run('after'); before = run('before'); }
      else { before = run('before'); after = run('after'); }
      trials.push({ beforeMs: before, afterMs: after, ratio: after / before });
    }
    rows.push({ id: c.id, cells: c.brief.cells.length, portals: c.brief.portals.length, trials });
    console.log(rows.at(-1));
  }
  const sources = Object.fromEntries(['map/micro/strategies/compound.ts', 'map/micro/strategies/compound-exterior.ts', 'map/micro/yard-handoff.ts']
    .map(p => [p, hash(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))]));
  writeFileSync(new URL('./timing.json', import.meta.url), JSON.stringify({ node: process.version,
    baselineSha256: hash(baselineBytes), beforeSourceSha256: hash(source.replaceAll('\r\n', '\n')),
    afterSourceHashes: sources, rows }, null, 2) + '\n');
} finally { unlinkSync(file); }
