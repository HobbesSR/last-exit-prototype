import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LARGER_CASES, compareSweep, runCase } from '../../map/tools/sweep.mts';

/**
 * Macro at the larger authored sizes, layout through briefs, against the committed chain
 * baseline (#821). The full sweep runs these cases too; this file keeps them on `main`'s slow
 * tier, where the root `map-library-24` and `-36*` files used to build whole maps for it. Macro's
 * own placement, proof and set-piece checks at these sizes are in `map/macro/tests/slow/chain-content`;
 * what builders make of these sizes' briefs is `micro-large-briefs`.
 */
const BASELINE = JSON.parse(readFileSync(new URL('../../map/tools/fixtures/chain-baseline.json', import.meta.url), 'utf8'));

for (const sweepCase of LARGER_CASES) test(`${sweepCase.id}: ${sweepCase.count} layouts and their briefs match the baseline`, () => {
  const entries = runCase(sweepCase);
  const pinned = Object.fromEntries(Object.keys(entries).map((key) => [key, BASELINE.entries[key]]));
  assert.deepEqual(compareSweep({ ...BASELINE, entries: pinned }, entries), []);
});
