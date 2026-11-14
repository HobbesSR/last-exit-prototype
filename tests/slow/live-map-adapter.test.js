import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt } from '../../map/live.ts';
import { generate } from '../../map/chain.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createMatch } from '../../server/match.js';

// Moved from tests/live-map-adapter.test.js (#849, #1071): game maps, slow-tier work (31). That seed 1's
// map is the one a room generates is held here; tests/slow/live-map.test.js leans on it. One build of
// seed 1's chain serves the file; no case mutates it.
let defaultBuilt;
const liveBuilt = () => defaultBuilt ??= composeRegions(generate('1', liveChainParams()).results);
const live = () => liveMapFromBuilt(1, liveBuilt());

test('the adapter is deterministic, content-sized, and is the default match map', async () => {
  // The match generates its own map, a second generation from the seed: equal, so deterministic and the default.
  const match = await createMatch(1);
  try {
    // The physics world states its props list, empty on a map that authors none.
    const { physicsProps, ...map } = match.map();
    assert.deepEqual(physicsProps, []);
    assert.deepEqual(map, live());
  } finally { match.dispose(); }
  const shipped = contentById('content-7');
  const twoHunters = { ...shipped, roster: { ...shipped.roster, gladiators: shipped.roster.gladiators.slice(0, 2) } };
  const earlier = generateLiveMap(1, twoHunters);
  assert.equal(earlier.hunterSpawns.length, twoHunters.roster.gladiators.length);
  assert.equal(earlier.spawns.length, twoHunters.roster.contestants.length);
});

test('the adapter rejects missing and extra required core sites', () => {
  const built = liveBuilt();
  const missing = structuredClone(built);
  const spawnRegion = missing.regions.find(region => region.coreElements.some(site => site.kind === 'spawn'));
  spawnRegion.coreElements.splice(spawnRegion.coreElements.findIndex(site => site.kind === 'spawn'), 1);
  assert.throws(() => liveMapFromBuilt(1, missing), /needs .* spawns/);
  const extra = structuredClone(built);
  const exitRegion = extra.regions.find(region => region.coreElements.some(site => site.kind === 'exit'));
  exitRegion.coreElements.push({ ...exitRegion.coreElements.find(site => site.kind === 'exit') });
  assert.throws(() => liveMapFromBuilt(1, extra), /one exit/);
});
