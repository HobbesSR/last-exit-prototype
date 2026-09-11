import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mapHashes, botTrace, scriptedTrace, seeds } from './characterization-scenarios.js';

const expected = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/behavior-5dd7d61.json.gz', import.meta.url))));
test('complete ordered maps match the pre-refactor checkpoint', () => assert.deepEqual(mapHashes(), expected.maps));
for (const seed of seeds) test(`every bot-match tick and projection matches 5dd7d61: seed ${seed}`, () => assert.deepEqual(botTrace(seed), expected.bots[seed]));
test('scripted authoritative snapshots and private projections match 5dd7d61', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(scriptedTrace())), expected.scripted);
});
