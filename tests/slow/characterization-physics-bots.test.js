import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { botTrace, seeds } from '../characterization-physics-scenarios.js';
import { packMap, unpackMap } from '../../server/map-pack.js';
import { prepareRuntimeNavigation } from '../../server/runtime-map.js';
import { packedTilesFor } from '../../shared/navigation/knowledge.ts';

const expected = deserialize(gunzipSync(readFileSync(new URL('../fixtures/behavior-physics-1.v8.gz', import.meta.url))));
const prepareMap = process.env.RUNTIME_MAP_PARITY === '1' ? async map => {
  const tiles = ['gladiator', 'contestant'].map(role => packedTilesFor(map, role));
  const decoded = unpackMap(packMap(map, tiles, { runtimeMap: true }));
  return { map: decoded, release: await prepareRuntimeNavigation(decoded) };
} : undefined;
// Whole physics bot matches on the arenas stored in the fixture (#920). The version check and the
// scripted trace, which are cheap, are in ../characterization-physics.test.js.
for (const seed of seeds) test(`every physics bot-match tick and projection matches the physics-1 checkpoint: seed ${seed}`,
  async () => assert.deepEqual(await botTrace(seed, expected.arenas[seed], undefined, prepareMap), expected.bots[seed]));
