// Reproduce retained outputs and source provenance across normal Git EOL policies.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { buildDepot, buildDepotExperiment } from '../map/micro/strategies/depot.ts';
import { compareMeasuredSource, hashSource } from './depot-cord-source.mjs';
const dir = process.argv[2] ?? 'docs/reports/issue-663';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resultsBytes = await readFile(`${dir}/results.json.gz`);
const report = JSON.parse(gunzipSync(resultsBytes));
const measured = JSON.parse(gunzipSync(await readFile(`${dir}/measured-sources.json.gz`)));
const inventory = new Map(measured.map(entry => [entry.path, entry]));
assert.equal(inventory.size, measured.length, 'duplicate measured source');
assert.equal(inventory.size, Object.keys(report.sourceHashes).length, 'complete measured inventory required');
const sourceFiles = [];
for (const [path, wanted] of Object.entries(report.sourceHashes)) {
  sourceFiles.push(compareMeasuredSource(path, await readFile(path, 'utf8'), inventory.get(path), wanted));
}
const comparisons = [];
for (const row of report.rows) {
  const brief = report.input.workloads.find(w => w.name === row.name).brief;
  for (const mode of ['production', 'fixed', 'movable']) {
    const actual = mode === 'production' ? { result: buildDepot(brief), diagnostics: null } : buildDepotExperiment(brief, mode);
    assert.deepEqual(actual.result, row.builds[mode].result, `${row.name}/${mode}: full result`);
    assert.deepEqual(actual.diagnostics, row.builds[mode].diagnostics, `${row.name}/${mode}: diagnostics, witness and empty intent`);
    comparisons.push({ name: row.name, mode, fullResultEqual: true, diagnosticsEqual: true });
  }
  console.log(`Verified ${row.name}`);
}
await writeFile(`${dir}/final-source-verification.json`, JSON.stringify({
  inputHash: report.inputHash, measuredResultsSha256: hash(resultsBytes), node: process.version,
  sourceHashEncoding: 'utf8-lf-single-final-newline; measured-only explicit historical trailing-whitespace cleanup',
  sourceFiles,
  verificationToolHashEncoding: 'utf8-lf',
  verificationToolSha256: hashSource(await readFile('tools/depot-cord-verify.mjs', 'utf8')),
  verificationSupportSha256: hashSource(await readFile('tools/depot-cord-source.mjs', 'utf8')),
  comparisons,
  scope: 'All 174 exact measured source texts are archived and checked against original raw hashes. Checkout comparison permits LF/CRLF and EOF blank-line normalization, plus explicit archived historical cleanup on two files; any other source change refuses. All 54 complete results, refusal counters, initial/final witnesses and empty intent match the retained capture. Original results and timing measurements are unchanged.'
}, null, 2) + '\n');
