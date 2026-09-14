import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mapHashes, botTrace, scriptedTrace, seeds } from './characterization-scenarios.js';

const expected = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/behavior-netcode-1.json.gz', import.meta.url))));
// What the generator emits, which a deliberate content change re-baselines on its own.
test('complete ordered maps match the netcode-1 checkpoint', () => assert.deepEqual(mapHashes(), expected.generated));
// What the simulation does, run against the arenas stored in the fixture rather than freshly
// generated ones, so these keep their meaning across content changes.
for (const seed of seeds) test(`every bot-match tick and projection matches the netcode-1 checkpoint: seed ${seed}`, () => assert.deepEqual(botTrace(seed, expected.maps[seed]), expected.bots[seed]));
test('scripted authoritative snapshots and private projections match the netcode-1 checkpoint', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(scriptedTrace(expected.maps[4217]))), expected.scripted);
});
