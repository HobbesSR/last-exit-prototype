import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt, liveRecipeMismatch, liveZoneSize, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES } from '../map/live.ts';
import { generate } from '../map/chain.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { defaultContent, contentById } from '../shared/simulation/content.ts';
import { createMatch } from '../server/match.js';

// One generation of seed 1's chain serves the file; live-map.test.js holds that it is the map generateLiveMap(1) makes.
let defaultMap, defaultChain, defaultBuilt;
const liveChain = () => defaultChain ??= generate('1', liveChainParams());
const liveBuilt = () => defaultBuilt ??= composeRegions(liveChain().results);
const live = () => defaultMap ??= liveMapFromBuilt(1, liveBuilt());

test('the adapter is deterministic, content-sized, and is the default match map', () => {
  // The match generates its own map, a second generation from the seed: equal, so deterministic and the default.
  assert.deepEqual(createMatch(1).map(), live());
  const twoHunters = contentById('content-1');
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

test('a room can be generated at each authored size, and only those', () => {
  assert.deepEqual(LIVE_ZONE_SIZES.map(({ zoneWidth, zoneHeight }) => `${zoneWidth}x${zoneHeight}`), ['12x6', '24x12', '36x18']);
  // A room naming no size is generated at the first; tests/slow/room-sizes plays a room at each size (ROOM_SIZES=all).
  assert.equal(DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES[0]);
  assert.equal(liveZoneSize({ zoneWidth: 24, zoneHeight: 6 }), undefined);
  assert.throws(() => generateLiveMap(1, defaultContent(), { zoneWidth: 24, zoneHeight: 6 }), /no bundled library/);
  const playground = { ...liveChain(), layout: { ...liveChain().layout, params: { ...liveChainParams(), mode: 'playground', zoneWidth: 20, zoneHeight: 9 } } };
  assert.match(liveRecipeMismatch(playground).join(), /20 x 9 zones isn't a size a room can use/);
});
