import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, readMap } from '../../map/tools/core.ts';
import { chainMapToJson, chainMapToBson } from '../../map/macro/src/chain/saving.ts';
import { assertSmallHouses } from '../helpers/hut-fixtures.js';

// The fast tier's tests/micro-hut.test.js runs the first seed of this sweep (#807).
test('small regions use a house with a reachable outside door', () => assertSmallHouses(Array.from({ length: 16 }, (_, i) => i + 1)));

// A whole game map, about 8 s, end to end for the hut adapter's brief (93aa5d4). The fast witness is
// micro-hut-delegation's broad yard, where `buildHut` must return its input brief; `map-tools`'
// game-map round trip does not catch the adapter dropping it (#807).
test('production hut adapters preserve Layout briefs for full chain saves', () => {
  const map = generate('last-exit-001');
  const json = chainMapToJson(map), bson = chainMapToBson(map);
  assert.deepEqual(readMap(JSON.parse(json)), map);
  assert.deepEqual(readMap(bson), map);
});
