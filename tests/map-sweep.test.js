import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../map/tools/core.ts';
import {
  QUICK_CASES, VIEWS, compareSweep, positiveInteger, runCase, stableStringify, sweepCases, viewHashes,
} from '../map/tools/sweep.mts';

/**
 * The chain's seed sweep (53, "Proving a change: the sweep"; #146). The quick cases are
 * pinned here against the committed baseline; the full sweep is `node map/tools/cli.mts
 * sweep --check map/tools/fixtures/chain-baseline.json`.
 */
const BASELINE = JSON.parse(readFileSync(new URL('../map/tools/fixtures/chain-baseline.json', import.meta.url), 'utf8'));
const SMALL = QUICK_CASES[0];

test('the quick cases match the committed baseline', () => {
  for (const sweepCase of QUICK_CASES) {
    const entries = runCase(sweepCase);
    const pinned = Object.fromEntries(Object.keys(entries).map((key) => [key, BASELINE.entries[key]]));
    assert.deepEqual(compareSweep({ ...BASELINE, entries: pinned }, entries), [], sweepCase.id);
  }
});

test('the baseline pins the cases it names, and the full sweep includes the quick ones', () => {
  const ids = BASELINE.provenance.cases.map((c) => c.id);
  for (const sweepCase of QUICK_CASES) assert.ok(ids.includes(sweepCase.id), sweepCase.id);
  const expected = BASELINE.provenance.cases.reduce((n, c) => n + c.count, 0);
  assert.equal(Object.keys(BASELINE.entries).length, expected);
  assert.deepEqual(sweepCases(BASELINE.provenance.cases[0].count), BASELINE.provenance.cases);
});

test('a change to one object moves only the views that read it', () => {
  const map = generate(`${SMALL.seedPrefix}-1`, SMALL.params);
  const base = viewHashes(map);
  assert.deepEqual(viewHashes(generate(`${SMALL.seedPrefix}-1`, SMALL.params)), base, 'deterministic within one process');
  // A result's loot is the builder's alone: macro's views don't read it.
  const results = map.results.map((result, i) => i ? result : { ...result, loot: [...result.loot, { x: 0, y: 0, tier: 1 }] });
  const moved = viewHashes({ ...map, results });
  assert.deepEqual(VIEWS.filter((view) => moved[view] !== base[view]), ['results', 'built', 'report']);
});

test('a map field the sweep does not pin is refused', () => {
  const map = generate(`${SMALL.seedPrefix}-1`, SMALL.params);
  assert.throws(() => viewHashes({ ...map, extra: 1 }), /map fields the sweep doesn't pin: extra/);
});

test('drift names the views that moved, and missing or unexpected seeds', () => {
  const hashes = Object.fromEntries(VIEWS.map((view) => [view, view]));
  const baseline = { provenance: BASELINE.provenance, entries: { a: hashes, b: hashes, e: { error: 'no layout' } } };
  assert.deepEqual(compareSweep(baseline, { a: hashes, b: { ...hashes, proof: 'x' }, c: hashes, e: { error: 'other' } }), [
    { key: 'b', views: ['proof'] },
    { key: 'c', views: ['unexpected'] },
    { key: 'e', views: ['error'] },
  ]);
  assert.deepEqual(compareSweep(baseline, { b: hashes, e: { error: 'no layout' } }), [{ key: 'a', views: ['missing'] }]);
});

test('hashing follows content: key order is ignored, and Infinity is not null', () => {
  assert.equal(stableStringify({ b: 1, a: [2, undefined] }), stableStringify({ a: [2, undefined], b: 1 }));
  assert.notEqual(stableStringify({ a: Infinity }), stableStringify({ a: null }));
  assert.equal(stableStringify(new Int32Array([1, 2])), stableStringify([1, 2]));
  assert.throws(() => stableStringify({ a: new Map() }), /a Map can't be hashed by content/);
  assert.throws(() => positiveInteger('count', '3.5'), /count must be a positive integer/);
  assert.throws(() => sweepCases(0), /count must be a positive integer/);
});
