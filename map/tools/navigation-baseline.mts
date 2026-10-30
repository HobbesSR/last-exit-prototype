#!/usr/bin/env node
/** Source-bound three-size #688 workload. --verify reads retained full maps and never overwrites evidence. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generate, readMap } from './core.ts';
import { chainMapToJson } from '../macro/src/chain/saving.ts';
import { measureNavigationStructure } from './navigation-structure.ts';

const dir = 'docs/reports/issue-688';
const verify = process.argv.includes('--verify');
if (process.argv.slice(2).some(a => a !== '--verify')) throw new Error('only --verify is supported');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const normalizedHash = (file: string) => hash(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sources = git('ls-files', 'map', 'shared', 'package-lock.json').split('\n').filter(f => /\.(ts|mts|json)$/.test(f) && !f.includes('/fixtures/'));
for (const f of ['map/tools/navigation-structure.ts', 'map/tools/navigation-baseline.mts']) if (!sources.includes(f)) sources.push(f);
const sourceHashes = Object.fromEntries(sources.sort().map(f => [f, normalizedHash(f)]));
const manifestPath = `${dir}/manifest.json`;
const retained = verify ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
if (retained) for (const [file, expected] of Object.entries(retained.sourceHashes)) assert.equal(normalizedHash(file), expected, `source ${file}`);
if (!verify && existsSync(manifestPath)) throw new Error('baseline exists; use --verify (never silently recapture)');
mkdirSync(dir, { recursive: true });
const maps = [];
for (const width of [12, 24, 36]) {
  const seed = `size-${width}-1`, file = `${dir}/${seed}.json.gz`, reportFile = `${dir}/${seed}-metrics.json.gz`;
  const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
  console.error(`${verify ? 'Verifying' : 'Measuring'} ${seed}`);
  const current = generate(seed, params, undefined, 48), currentJson = chainMapToJson(current);
  const input = verify ? gunzipSync(readFileSync(file)).toString('utf8') : currentJson;
  assert.equal(hash(currentJson), hash(input), `${seed}: generated content drift`);
  const map = readMap(JSON.parse(input)), before = chainMapToJson(map);
  const metrics = measureNavigationStructure(map);
  assert.equal(chainMapToJson(map), before, `${seed}: measurement mutated input`);
  const report = JSON.stringify(metrics);
  if (verify) {
    assert.deepEqual(metrics, JSON.parse(gunzipSync(readFileSync(reportFile)).toString('utf8')), `${seed}: metric drift`);
    const pin = retained.maps.find((m: { seed: string }) => m.seed === seed);
    assert.equal(hash(input), pin.mapSha256); assert.equal(hash(report), pin.metricsSha256);
  } else {
    writeFileSync(file, gzipSync(input)); writeFileSync(reportFile, gzipSync(report));
  }
  maps.push({ seed, params, mapFile: file, metricsFile: reportFile, mapSha256: hash(input), metricsSha256: hash(report), librarySha256: hash(JSON.stringify(map.library)),
    regions: metrics.regions, portals: metrics.portals, onePortalShare: metrics.onePortalShare,
    bodies: metrics.roles.map(r => ({ body: r.body, walkableArea: r.walkableArea, deadEndArea: r.deadEndArea, components: r.components,
      emptyAreaEstimate: r.regions.reduce((n, p) => n + p.emptyAreaEstimate, 0),
      walkableSamples: r.regions.reduce((n, p) => n + p.walkableSamples, 0), emptySamples: r.regions.reduce((n, p) => n + p.emptySamples, 0),
      boundarySamples: r.regions.reduce((n, p) => n + p.boundarySamples, 0), blockedBoundarySamples: r.regions.reduce((n, p) => n + p.blockedBoundarySamples, 0),
      detour: r.detour, sampling: r.sampling })) });
}
if (!verify) writeFileSync(manifestPath, JSON.stringify({ contentRevision: git('rev-parse', 'HEAD'), node: process.version, sourceHashes, maps }, null, 2) + '\n');
console.error(`${verify ? 'Verified' : 'Recorded'} three maps with exact content and metric hashes.`);
