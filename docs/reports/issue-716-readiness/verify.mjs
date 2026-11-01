import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [source, output] = process.argv.slice(2);
if (!output) throw Error('Usage: verify.mjs LOCAL_REPAIR_SOURCE NEW_OUTPUT');
const hash = b => createHash('sha256').update(b).digest('hex'), root = path.resolve(source);
const load = f => import(pathToFileURL(path.join(root, f)));
const { buildRegion } = await load('map/micro/region-types.ts');
const { reorderedBrief } = await load('tests/helpers/chain-briefs.js');
const corpusBytes = fs.readFileSync(path.join(root, 'docs/reports/issue-716/frozen-corpus.json.gz')), corpus = JSON.parse(gunzipSync(corpusBytes));
const report = { guardSha256: hash(fs.readFileSync(path.join(root, 'map/micro/strategies/content-access.ts'))), corpusSha256: hash(corpusBytes), checks: [], rows: [], complete: false };
fs.writeFileSync(output, JSON.stringify(report), { flag: 'wx' });
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const lock = await acquireMachineLock('bench', { timeoutMs: 30 * 60_000, pollMs: 100 });
try {
  for (const args of [
    [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit'],
    [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'map/tools'],
    ['--test', '--test-isolation=none', 'tests/micro-content-access.test.js'],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true });
    report.checks.push({ args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }); save();
    if (result.status !== 0) throw Error(`Focused check failed: ${args.join(' ')}`);
  }
  const body = ({ elements, loot, coreElements, manifest }) => ({ elements, loot, coreElements, manifest });
  for (const row of [...corpus.rows, ...corpus.additionalParentRows]) {
    const actual = [structuredClone(row.brief), reorderedBrief(row.brief, row.brief.seed)].map(brief => hash(JSON.stringify(body(buildRegion(brief)))));
    report.rows.push({ seed: row.seed, id: row.brief.id, expected: row.sha256, actual }); save();
    if (actual.some(h => h !== row.sha256)) throw Error(`Repeat/reordered drift: ${row.brief.id}`);
  }
  report.complete = true; save(); console.log('Typechecks, 9 access tests, 142 repeat/reordered output pairs passed.');
} finally { lock.release(); }
