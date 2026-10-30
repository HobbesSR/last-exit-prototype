// Verify that retained compound witnesses are actually emitted by matching libraries.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CHAIN_LIBRARIES } from '../../../map/chain.ts';
import { generateChainMap, mapViews } from '../../../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../../../map/micro/region-types.ts';
import { composeRegions } from '../../../map/micro/compose.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const before = JSON.parse(gunzipSync(readFileSync(new URL('./before.json.gz', import.meta.url))));
const after = JSON.parse(readFileSync(new URL('./after.json', import.meta.url)));
for (const [path, expected] of Object.entries(after.sourceHashes))
  assert.equal(hash(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')), expected, `current source ${path}`);
const rows = [];
for (const sample of before.samples) {
  console.log(`Generating ${sample.seed}`);
  const library = CHAIN_LIBRARIES.find(l => l.zoneWidth === sample.params.zoneWidth && l.zoneHeight === sample.params.zoneHeight);
  const map = generateChainMap(sample.seed, sample.params, library, 48,
    { version: REGION_TYPES_VERSION, build: buildRegion, compose: composeRegions });
  const defects = mapViews(map, composeRegions).report.defects;
  assert.deepEqual(defects, []);
  const compounds = map.results.filter(r => r.brief.type === 'compound');
  assert.deepEqual(compounds.map(r => r.brief.id), sample.compounds.map(c => c.id));
  const expected = after.samples.find(s => s.seed === sample.seed);
  for (const result of compounds) {
    assert.deepEqual(result.brief, sample.compounds.find(c => c.id === result.brief.id).brief);
    assert.equal(hash(JSON.stringify(result)), expected.rows.find(r => r.id === result.brief.id).afterHash);
  }
  rows.push({ seed: sample.seed, params: sample.params, compounds: compounds.length,
    outbuildings: compounds.reduce((n, r) => n + r.elements.filter(e => e.label === 'compound-outbuilding').length, 0), defects });
}
const report = { version: REGION_TYPES_VERSION,
  afterSha256: hash(readFileSync(new URL('./after.json', import.meta.url), 'utf8').replaceAll('\r\n', '\n')), rows };
const file = new URL('./chain.json', import.meta.url);
if (process.argv.includes('--verify')) assert.deepEqual(report, JSON.parse(readFileSync(file)));
else writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
