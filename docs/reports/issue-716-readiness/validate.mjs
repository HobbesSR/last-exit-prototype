// Independent final geometry, target access and repeat/reordered builds for the measured candidate.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [source, panel, output] = process.argv.slice(2);
if (!output) throw Error('Usage: validate.mjs SOURCE PANEL NEW_OUTPUT');
const load = f => import(pathToFileURL(path.resolve(source, f)));
const { readChainMap } = await load('map/macro/src/chain/saving.ts');
const { validateRegion } = await load('tools/incidental-seam-validate.mjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const manifestBytes = fs.readFileSync(path.resolve(panel, 'manifest.json')), manifest = JSON.parse(manifestBytes);
fs.mkdirSync(output);
const report = { panelManifestSha256: hash(manifestBytes), validatorSha256: hash(fs.readFileSync(path.resolve(source, 'tools/incidental-seam-validate.mjs'))), maps: [], totals: { owners: 0, fillErrors: 0, portalFailures: 0, rebuildDrift: 0, loot: {} } };
const lock = await acquireMachineLock('bench', { timeoutMs: 30 * 60_000, pollMs: 100 });
try {
  for (const entry of manifest.cases) {
    const bytes = fs.readFileSync(path.resolve(panel, `${entry.seed}.json.gz`));
    if (hash(bytes) !== entry.artifacts[`${entry.seed}.json.gz`]) throw Error('Capture drift');
    const map = readChainMap(gunzipSync(bytes)), results = [];
    for (const r of map.results.filter(r => ['depot', 'market', 'block'].includes(r.brief.type))) {
      const result = validateRegion(r, { rebuild: true }); results.push(result);
      report.totals.owners++; report.totals.fillErrors += result.fillErrors.length;
      report.totals.portalFailures += Number(!result.portal.valid);
      report.totals.rebuildDrift += Number(Object.values(result.builds).some(v => v !== null));
      for (const { role, targets } of result.loot) {
        const counts = report.totals.loot[role] ??= {};
        for (const target of targets) counts[target.status] = (counts[target.status] ?? 0) + 1;
      }
    }
    const file = `${entry.seed}-validation.json.gz`, raw = gzipSync(JSON.stringify({ seed: entry.seed, results }));
    fs.writeFileSync(path.resolve(output, file), raw, { flag: 'wx' });
    report.maps.push({ seed: entry.seed, inputSha256: hash(bytes), file, sha256: hash(raw), owners: results.length });
    fs.writeFileSync(path.resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ seed: entry.seed, ...report.totals }));
  }
  report.complete = true;
  fs.writeFileSync(path.resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
} finally { lock.release(); }
