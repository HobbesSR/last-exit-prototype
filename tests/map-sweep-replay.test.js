import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SHARED_MANIFEST } from '../map/micro/result.ts';
import { QUICK_CASES } from '../map/tools/sweep.mts';
import { captureBriefs, replayBriefs, replayFailed, typesToReplay } from '../map/tools/sweep-briefs.mts';

/**
 * The brief replay (53, "Replaying one region type"; #541). The quick cases are captured once
 * against the committed baseline's own hashes, and each test replays or tampers with a copy.
 */
const BASELINE = JSON.parse(readFileSync(new URL('../map/tools/fixtures/chain-baseline.json', import.meta.url), 'utf8'));
const keys = QUICK_CASES.flatMap((c) => Array.from({ length: c.count }, (_, i) => `${c.id}/${c.seedPrefix}-${i + 1}`));
const baseline = { provenance: { ...BASELINE.provenance, cases: QUICK_CASES }, entries: Object.fromEntries(keys.map((key) => [key, BASELINE.entries[key]])) };
const withEntry = (key, changes) => ({ ...baseline, entries: { ...baseline.entries, [key]: { ...baseline.entries[key], ...changes } } });

const dirs = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sweep-briefs-')); dirs.push(dir); return dir; };
const captured = tempDir();
const copy = () => { const dir = tempDir(); cpSync(captured, dir, { recursive: true }); return dir; };
const index = (dir) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
/** The cached records of one type for the first map holding it, and a way to write them back. */
function cached(dir, type) {
  const key = Object.keys(index(dir).maps).find((k) => index(dir).maps[k].types[type]);
  const file = join(dir, 'regions', type, `${key}.json.gz`);
  const records = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  return { key, records, save: () => writeFileSync(file, gzipSync(JSON.stringify(records))) };
}

before(async () => { await captureBriefs(baseline, captured, 2); });
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('rebuilding unchanged builders finds nothing, and counts the type\'s own features', async () => {
  const plants = Object.values(index(captured).maps).reduce((n, m) => n + (m.types.plant ?? 0), 0);
  assert.ok(plants > 0, 'the quick cases hold a plant');
  const report = await replayBriefs(baseline, ['plant'], { dir: captured, jobs: 2 });
  assert.equal(report.regions, plants);
  assert.deepEqual([report.drift, report.threw, report.brokenPromises], [[], [], []]);
  assert.equal(replayFailed(report), false);
  const { records } = cached(captured, 'plant');
  assert.deepEqual(Object.keys(report.features.plant), Object.keys(records[0].manifest).filter((k) => !SHARED_MANIFEST.includes(k)));
  assert.ok(report.features.plant.machines.total > 0);
  assert.equal(report.reachChecked, 0, 'nothing drifted, so nothing needed the portal check');
});

test('a manifest begins with the shared counts, so what follows is the type\'s own', () => {
  const { records } = cached(captured, 'open');
  assert.deepEqual(Object.keys(records[0].manifest).slice(0, SHARED_MANIFEST.length), [...SHARED_MANIFEST]);
});

test('a region whose result moved is named by map and region, with the counts that moved', async () => {
  const dir = copy(), { key, records, save } = cached(dir, 'plant');
  const { brief, manifest } = records[0];
  records[0].hash = 'moved';
  records[0].manifest = { ...manifest, machines: manifest.machines + 1 };
  save();
  const report = await replayBriefs(baseline, ['plant'], { dir, jobs: 2 });
  assert.deepEqual(report.drift, [{ map: key, region: brief.id, type: 'plant', manifest: { machines: [manifest.machines + 1, manifest.machines] } }]);
  assert.equal(replayFailed(report), true);
  assert.equal(report.reachChecked, 1, 'only the drifted region was checked');
  assert.equal((await replayBriefs(baseline, ['plant'], { dir, jobs: 2, reach: 'all' })).reachChecked, report.regions);
  assert.equal((await replayBriefs(baseline, ['plant'], { dir, jobs: 2, reach: 'none' })).reachChecked, 0);
});

test('a region that throws is named and the rest are still rebuilt', async () => {
  const dir = copy(), { key, records, save } = cached(dir, 'plant');
  records[0].brief.cells = [];
  save();
  const report = await replayBriefs(baseline, ['plant'], { dir, jobs: 2 });
  assert.equal(report.threw.length, 1);
  assert.deepEqual({ ...report.threw[0], error: undefined }, { map: key, region: records[0].brief.id, type: 'plant', error: undefined });
  assert.match(report.threw[0].error, /Invalid brief/);
  assert.equal(report.drift.length, 0);
  assert.equal(replayFailed(report), true);
});

test('a cache the baseline has moved past, or none at all, is refused', async () => {
  const [key] = keys;
  for (const view of ['briefs', 'results'])
    await assert.rejects(replayBriefs(withEntry(key, { [view]: 'moved' }), ['plant'], { dir: captured, jobs: 2 }), /briefs cache is stale.*recapture/s, view);
  await assert.rejects(replayBriefs({ ...baseline, entries: { ...baseline.entries, extra: baseline.entries[key] } }, ['plant'], { dir: captured }), /stale/);
  await assert.rejects(replayBriefs(baseline, ['plant'], { dir: tempDir() }), /no briefs cache/);
});

test('a type the cache holds no region of is refused rather than passing on nothing', async () => {
  const dir = copy(), file = join(dir, 'index.json'), changed = index(dir);
  for (const map of Object.values(changed.maps)) delete map.types.plant;
  writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(replayBriefs(baseline, ['plant'], { dir }), /holds no region of type plant/);
});

/** The cheap playground maps alone, with one hash that this tree can't reproduce. */
function movedBaseline() {
  const [small] = QUICK_CASES;
  const entries = Object.fromEntries(keys.filter((k) => k.startsWith(`${small.id}/`)).map((k) => [k, baseline.entries[k]]));
  return { provenance: { ...baseline.provenance, cases: [small] }, entries: { ...entries, [keys[0]]: { ...entries[keys[0]], built: 'moved' } } };
}

test('capture refuses a tree that does not reproduce the baseline, and leaves no cache', async () => {
  const dir = tempDir();
  await assert.rejects(captureBriefs(movedBaseline(), dir, 2), /doesn't reproduce the baseline: 1 of 3 maps moved, .*built/);
  for (const name of ['index.json', 'regions', 'regions.new']) assert.equal(existsSync(join(dir, name)), false, name);
});

test('a refused capture leaves the previous cache as it was', async () => {
  const dir = copy(), before = readFileSync(join(dir, 'index.json'), 'utf8');
  await assert.rejects(captureBriefs(movedBaseline(), dir, 2), /doesn't reproduce the baseline/);
  assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'regions.new')), false);
  assert.deepEqual((await replayBriefs(baseline, ['plant'], { dir, jobs: 2 })).drift, []);
});

test('capture will not empty a directory that holds other files', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  await assert.rejects(captureBriefs(baseline, dir, 2), /aren't a briefs cache/);
  assert.deepEqual(readdirSync(dir), ['notes.txt']);
});

test('a type names its strategy\'s other types, and an unknown one is refused', () => {
  assert.deepEqual(typesToReplay('hall'), ['hall', 'market']);
  assert.deepEqual(typesToReplay('market, plant'), ['hall', 'plant', 'market']);
  assert.throws(() => typesToReplay('plant,nope'), /unknown region type nope; the types are .*plant/);
  assert.throws(() => typesToReplay(' , '), /names no region type/);
});
