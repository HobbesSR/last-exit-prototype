import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { checkBrief } from '../helpers/builder-contract.js';

/**
 * What builders make of the briefs only the larger authored sizes hand them (#821): per type,
 * the 24 × 12 or 36 × 18 brief with the most portals or cells, where it beats the full
 * sweep's 12 × 6 maps (`tools/large-briefs.mjs`, tests/fixtures README). The root
 * `map-library-24` and `-36*` files used to build five whole maps a size for this, at about
 * 85% of their 353 s; macro at those sizes is pinned by the chain sweep's `macro-*` cases
 * (tests/slow/map-macro-sizes.test.js), and composing and reporting run at 12 × 6.
 *
 * The claims are the ones those maps' reports made of a region: it builds, keeps its geometry
 * in the fill, counts every cell and sites the core elements it was asked for. The portal
 * promise is left to the type's own files and the sweep's diagnosis: on these briefs the
 * thorough search costs up to 80 s where the build costs one.
 */
const { briefs } = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/large-briefs.json.gz', import.meta.url))));
const BUILDS_NOTHING = new Set(['open']);

const byType = new Map();
for (const entry of briefs) byType.set(entry.brief.type, [...byType.get(entry.brief.type) ?? [], entry]);

for (const [type, entries] of byType) test(`large briefs: ${type} builds what the larger sizes hand it`, () => {
  const found = [];
  for (const { seed, brief } of entries) {
    const at = `${seed}/${brief.id} (${brief.portals.length} portals, ${brief.cells.length} cells)`;
    const { result, found: problems } = checkBrief(brief, { reach: false, reorder: false });
    for (const problem of problems) found.push(`${at}: ${problem}`);
    if (result && !BUILDS_NOTHING.has(type) && !result.elements.length) found.push(`${at}: built no geometry, so it proves nothing`);
  }
  assert.deepEqual(found, []);
});

test('the stored briefs are the larger sizes\' extremes, at least one per type that has them', () => {
  assert.ok(byType.size >= 10, `${byType.size} types`);
  for (const { axes } of briefs) for (const { value, sweepMax } of Object.values(axes)) assert.ok(value > sweepMax);
});
