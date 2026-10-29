// Verify final source after whitespace-only cleanup against every retained comparison output.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { buildDepot, buildDepotExperiment } from '../map/micro/strategies/depot.ts';
const dir = process.argv[2] ?? 'docs/reports/issue-663';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resultsBytes = await readFile(`${dir}/results.json.gz`);
const report = JSON.parse(gunzipSync(resultsBytes));
const measured = JSON.parse(gunzipSync(await readFile(`${dir}/measured-sources.json.gz`)));
const normalized = text => text.replace(/[ \t]+(?=\r?$)/gm, '').replace(/(?:\r?\n)+$/, text.includes('\r\n') ? '\r\n' : '\n');
const sourceChanges = [];
const finalSourceHashes = {};
for (const [path, wanted] of Object.entries(report.sourceHashes)) {
  const actual = await readFile(path);
  finalSourceHashes[path] = hash(actual);
  if (hash(actual) !== wanted) {
    const before = measured.find(entry => entry.path === path);
    assert.ok(before, `${path}: unrecorded source change`);
    assert.equal(hash(before.text), wanted, `${path}: measured source archive`);
    assert.equal(normalized(before.text), actual.toString(), `${path}: only trailing whitespace and EOF blank lines may change`);
    sourceChanges.push({ path, measuredSha256: wanted, finalSha256: hash(actual), change: 'trailing whitespace / blank lines at EOF only' });
  }
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
const tool = 'tools/depot-cord-verify.mjs';
await writeFile(`${dir}/final-source-verification.json`, JSON.stringify({
  inputHash: report.inputHash, measuredResultsSha256: hash(resultsBytes), node: process.version,
  sourceChanges, finalSourceHashes, verificationToolSha256: hash(await readFile(tool)), comparisons,
  scope: 'No executable change after measurement: only recorded trailing whitespace/EOF cleanup. All 54 complete results, refusal counters, initial/final witnesses and empty intent match the geometry capture. Original measured source bytes are retained separately; timings remain bound to those source hashes.'
}, null, 2) + '\n');
