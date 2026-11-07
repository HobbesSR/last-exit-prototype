import test from 'node:test';
import assert from 'node:assert/strict';
import { liveChainParams, liveMismatch, liveRecipeMismatch, liveSeed } from '../../map/live.ts';
import { generate } from '../../map/chain.ts';

// Moved from tests/live-map.test.js (#849): liveMismatch regenerates seed 1's chain to compare, so this
// builds two game maps, slow-tier work (31). The turned slot is compared with this chain, passed as `fresh` (#822).
let seedOneChain;
const liveChain = () => seedOneChain ??= generate('1', liveChainParams());

test("a chain map the Map Lab calls live names a room seed and recipe, and only the seed's own map passes", () => {
  const chain = liveChain();
  assert.deepEqual(liveMismatch(chain), []);
  assert.equal(liveSeed(chain.layout.seed), 1, "the chain's seed text names the room seed whose map it is");
  const other = { ...chain, layout: { ...chain.layout, seed: '01', params: { ...chain.layout.params, exitCount: 2 } },
    library: { ...chain.library, name: 'draft' }, cellSize: 32, build: 'older' };
  assert.deepEqual(liveMismatch(other).map(reason => reason.split(' ').slice(0, 2).join(' ')),
    ['the seed', 'exitCount is', 'the library', 'the cell', 'the regions']);
  // A loaded save can keep its seed and recipe and still be edited: only the seed's own map is a room's.
  const turned = structuredClone(chain), slot = turned.layout.slots[0];
  slot.orientation = slot.orientation === 0 ? 90 : 0;
  assert.deepEqual(liveRecipeMismatch(turned), []);
  assert.match(liveMismatch(turned, undefined, chain).join(), /^the map isn't the one its seed generates \(layout\.slots\[0\]\.orientation: /);
  const moved = structuredClone(chain);
  moved.results[0].coreElements.push({ kind: 'charger', x: 0, y: 0 });
  // Without `fresh`: an edited map is refused by the path the Lab runs.
  assert.match(liveMismatch(moved).join(), /\(results\[0\]\.coreElements/);
  for (const seed of ['0', '1e3', '2147483648', '1.5', ' 7', 'last-exit-001']) assert.equal(liveSeed(seed), null, seed);
  assert.equal(liveSeed('2147483647'), 2147483647);
});
