import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveRecipeMismatch, liveZoneSize, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES } from '../map/live.ts';
import { generateMacro } from '../map/chain.ts';
import { defaultContent } from '../shared/simulation/content.ts';

// Macro alone states the recipe, so no region is built here. The core-site case reads seed 1's built
// chain and is in tests/slow/live-map-adapter.test.js: building a map is slow-tier work (31, #1071).
let defaultChain;
const liveChain = () => defaultChain ??= generateMacro('1', liveChainParams());

test('a room can be generated at each authored size, and only those', () => {
  assert.deepEqual(LIVE_ZONE_SIZES.map(({ zoneWidth, zoneHeight }) => `${zoneWidth}x${zoneHeight}`), ['12x6', '24x12', '36x18']);
  // A room naming no size is generated at the first; tests/slow/room-sizes plays a room at each size (ROOM_SIZES=all).
  assert.equal(DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES[0]);
  assert.equal(liveZoneSize({ zoneWidth: 24, zoneHeight: 6 }), undefined);
  assert.throws(() => generateLiveMap(1, defaultContent(), { zoneWidth: 24, zoneHeight: 6 }), /no bundled library/);
  const playground = { ...liveChain(), layout: { ...liveChain().layout, params: { ...liveChainParams(), mode: 'playground', zoneWidth: 20, zoneHeight: 9 } } };
  assert.match(liveRecipeMismatch(playground).join(), /20 x 9 zones isn't a size a room can use/);
});
