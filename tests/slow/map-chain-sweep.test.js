import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../../map/tools/core.ts';
import { MACRO_VIEWS, QUICK_CASES, compareSweep, macroHashes, runCase, viewHashes } from '../../map/tools/sweep.mts';
import { generateMacro } from '../../map/chain.ts';

// The game-size quick case, moved from tests/map-sweep.test.js (#849): it builds a 12 x 6 game map,
// slow-tier work (31). The fast file keeps the playground quick cases.
const BASELINE = JSON.parse(readFileSync(new URL('../../map/tools/fixtures/chain-baseline.json', import.meta.url), 'utf8'));
const GAME = QUICK_CASES.find((sweepCase) => sweepCase.id === 'game');

test('the game quick case matches the committed baseline, and generateMacro gives its macro views', () => {
  const entries = runCase(GAME);
  const pinned = Object.fromEntries(Object.keys(entries).map((key) => [key, BASELINE.entries[key]]));
  assert.deepEqual(compareSweep({ ...BASELINE, entries: pinned }, entries), []);
  const seed = `${GAME.seedPrefix}-1`, whole = viewHashes(generate(seed, GAME.params)), macro = generateMacro(seed, GAME.params);
  assert.deepEqual(macroHashes(macro), Object.fromEntries(MACRO_VIEWS.map((view) => [view, whole[view]])));
  assert.deepEqual(macro.results, []);
});
