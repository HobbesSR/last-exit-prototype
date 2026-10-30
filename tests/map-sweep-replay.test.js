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

// The current quick game case supplies populated market stalls; it no longer
// supplies plant machines. Keep the same generic replay/feature/refusal checks.
test('rebuilding unchanged builders finds nothing, and counts the type\'s own features', async () => {
  const markets = Object.values(index(captured).maps).reduce((n, m) => n + (m.types.market ?? 0), 0);
  assert.ok(markets > 0, 'the quick cases hold a market');
  const report = await replayBriefs(baseline, ['market'], { dir: captured, jobs: 2 });
  assert.equal(report.regions, markets);
  assert.deepEqual([report.drift, report.threw, report.brokenPromises], [[], [], []]);
  assert.equal(replayFailed(report), false);
  const { records } = cached(captured, 'market');
  assert.deepEqual(Object.keys(report.features.market), Object.keys(records[0].manifest).filter((k) => !SHARED_MANIFEST.includes(k)));
  assert.ok(report.features.market.stalls.total > 0);
  assert.equal(report.reachChecked, 0, 'nothing drifted, so nothing needed the portal check');
});

test('a manifest begins with the shared counts, so what follows is the type\'s own', () => {
  const { records } = cached(captured, 'open');
  assert.deepEqual(Object.keys(records[0].manifest).slice(0, SHARED_MANIFEST.length), [...SHARED_MANIFEST]);
});

test('a region whose result moved is named by map and region, with the counts that moved', async () => {
  const dir = copy(), { key, records, save } = cached(dir, 'market');
  const { brief, manifest } = records[0];
  records[0].hash = 'moved';
  records[0].manifest = { ...manifest, stalls: manifest.stalls + 1 };
  save();
  const report = await replayBriefs(baseline, ['market'], { dir, jobs: 2 });
  assert.deepEqual(report.drift, [{ map: key, region: brief.id, type: 'market', manifest: { stalls: [manifest.stalls + 1, manifest.stalls] } }]);
  assert.equal(replayFailed(report), true);
  assert.equal(report.reachChecked, 1, 'only the drifted region was checked');
  assert.equal((await replayBriefs(baseline, ['market'], { dir, jobs: 2, reach: 'all' })).reachChecked, report.regions);
  assert.equal((await replayBriefs(baseline, ['market'], { dir, jobs: 2, reach: 'none' })).reachChecked, 0);
});

test('a region that throws is named and the rest are still rebuilt', async () => {
  const dir = copy(), { key, records, save } = cached(dir, 'market');
  records[0].brief.cells = [];
  save();
  const report = await replayBriefs(baseline, ['market'], { dir, jobs: 2 });
  assert.equal(report.threw.length, 1);
  assert.deepEqual({ ...report.threw[0], error: undefined }, { map: key, region: records[0].brief.id, type: 'market', error: undefined });
  assert.match(report.threw[0].error, /Invalid brief/);
  assert.equal(report.drift.length, 0);
  assert.equal(replayFailed(report), true);
});

test('a cache the baseline has moved past, or none at all, is refused', async () => {
  const [key] = keys;
  for (const view of ['briefs', 'results'])
    await assert.rejects(replayBriefs(withEntry(key, { [view]: 'moved' }), ['market'], { dir: captured, jobs: 2 }), /briefs cache is stale.*recapture/s, view);
  await assert.rejects(replayBriefs({ ...baseline, entries: { ...baseline.entries, extra: baseline.entries[key] } }, ['market'], { dir: captured }), /stale/);
  await assert.rejects(replayBriefs(baseline, ['market'], { dir: tempDir() }), /no briefs cache/);
});

/** A copy of the cache whose index says it holds none of `types`. */
function without(...types) {
  const dir = copy(), changed = index(dir);
  for (const map of Object.values(changed.maps)) for (const type of types) delete map.types[type];
  writeFileSync(join(dir, 'index.json'), JSON.stringify(changed));
  return dir;
}
const typesHeld = (dir) => new Set(Object.values(index(dir).maps).flatMap((map) => Object.keys(map.types)));

test('a type the cache holds no region of is refused rather than passing on nothing', async () => {
  await assert.rejects(replayBriefs(baseline, ['market'], { dir: without('market') }), /holds no region of type market/);
  await assert.rejects(replayBriefs(baseline, [], { dir: captured }), /no region type to replay/);
});

test('each requested strategy needs a region of its own, so one cannot pass for another', async () => {
  const other = [...typesHeld(captured)].find((type) => !['hall', 'market'].includes(type));
  assert.ok(other, 'the quick cases hold a type besides market and the hall pair');
  const dir = without('market');
  await assert.rejects(replayBriefs(baseline, ['market', other], { dir }), /holds no region of type market$/);
  await assert.rejects(replayBriefs(baseline, [other, 'market'], { dir }), /holds no region of type market$/);
  assert.equal((await replayBriefs(baseline, [other], { dir, jobs: 2 })).types[0], other, 'the others are still replayable');
});

test('hall and market replay independently, each requiring its own cached regions', async () => {
  assert.ok(typesHeld(captured).has('market'), 'the quick cases hold a market');
  assert.deepEqual(typesToReplay('hall'), ['hall']);
  assert.deepEqual(typesToReplay('market'), ['market']);
  const dir = without('hall');
  await assert.rejects(replayBriefs(baseline, ['hall', 'market'], { dir, jobs: 2 }), /holds no region of type hall$/);
  const markets = Object.values(index(dir).maps).reduce((n, m) => n + (m.types.market ?? 0), 0);
  const report = await replayBriefs(baseline, ['market'], { dir, jobs: 2 });
  assert.deepEqual([report.types, report.regions, report.drift], [['market'], markets, []]);
  await assert.rejects(replayBriefs(baseline, ['market'], { dir: without('market') }), /holds no region of type market$/);
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
  assert.deepEqual((await replayBriefs(baseline, ['market'], { dir, jobs: 2 })).drift, []);
});

test('capture will not empty a directory that holds other files', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  await assert.rejects(captureBriefs(baseline, dir, 2), /aren't a briefs cache/);
  assert.deepEqual(readdirSync(dir), ['notes.txt']);
});

test('types select independent strategies, and an unknown one is refused', () => {
  assert.deepEqual(typesToReplay('hall'), ['hall']);
  assert.deepEqual(typesToReplay('market, plant'), ['plant', 'market']);
  assert.throws(() => typesToReplay('plant,nope'), /unknown region type nope; the types are .*plant/);
  assert.throws(() => typesToReplay(' , '), /names no region type/);
});
