import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mapHashes, scriptedTrace } from './characterization-scenarios.js';
import { contentById } from '../shared/simulation/content.ts';

const expected = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/behavior-netcode-1.json.gz', import.meta.url))));
// What the generator emits, which a deliberate content change re-baselines on its own.
test('complete ordered maps match the netcode-1 checkpoint', () => assert.deepEqual(mapHashes(), expected.generated));
// What the simulation does, run against the arenas stored in the fixture rather than freshly
// generated ones, so these keep their meaning across content changes. The full bot-match traces
// take twenty seconds and run in `npm run test:all` (slow/characterization-bots.test.js).
test('scripted authoritative snapshots and private projections match the netcode-1 checkpoint', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(scriptedTrace(expected.maps[4217], contentById('content-1')))), expected.scripted);
});
