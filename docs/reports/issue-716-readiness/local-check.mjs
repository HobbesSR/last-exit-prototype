// A fail-closed first gate for the local-repair experiment, before timing claims.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [source, output] = process.argv.slice(2);
if (!output) throw Error('Usage: local-check.mjs CANDIDATE NEW_OUTPUT');
const hash = b => createHash('sha256').update(b).digest('hex');
const corpusBytes = fs.readFileSync(path.resolve(source, 'docs/reports/issue-716/frozen-corpus.json.gz'));
const corpus = JSON.parse(gunzipSync(corpusBytes));
const { buildRegion } = await import(pathToFileURL(path.resolve(source, 'map/micro/region-types.ts')));
const content = ({ elements, loot, coreElements, manifest }) => ({ elements, loot, coreElements, manifest });
const report = { corpusSha256: hash(corpusBytes), guardSha256: hash(fs.readFileSync(path.resolve(source, 'map/micro/strategies/content-access.ts'))), rows: [], status: 'pending' };
fs.writeFileSync(output, JSON.stringify(report), { flag: 'wx' });
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const lock = await acquireMachineLock('bench', { timeoutMs: 30 * 60_000, pollMs: 100 });
try {
  for (const row of [...corpus.rows, ...corpus.additionalParentRows]) {
    const actual = content(buildRegion(structuredClone(row.brief))), actualHash = hash(JSON.stringify(actual));
    const result = { seed: row.seed, id: row.brief.id, type: row.brief.type, expected: row.sha256, actual: actualHash, equal: actualHash === row.sha256 };
    report.rows.push(result); save();
    if (!result.equal) {
      report.status = 'output-drift';
      // Retain the first mismatch in full; never replace the immutable expected corpus.
      report.firstMismatch = { brief: row.brief, expected: row.expected, actual };
      console.log(JSON.stringify(result)); break;
    }
  }
  if (report.status === 'pending') report.status = 'all-142-match';
  save(); console.log(JSON.stringify({ status: report.status, checked: report.rows.length }));
} finally { lock.release(); }
