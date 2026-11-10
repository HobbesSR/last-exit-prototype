import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { CONTENT, scriptedTrace } from './characterization-physics-scenarios.js';
import { PHYSICS_VERSION } from '../shared/simulation.ts';

// The live engine's frozen characterization (#920). The arenas are stored in the fixture with their
// portal graphs (v8, since the graph holds typed arrays), so these keep their meaning when generation moves.
const expected = deserialize(gunzipSync(readFileSync(new URL('./fixtures/behavior-physics-1.v8.gz', import.meta.url))));

test('the physics-1 checkpoint names the rules version and content it characterizes', () => {
  assert.equal(expected.version, PHYSICS_VERSION, 'a rules version change is a decision that recaptures this fixture');
  assert.equal(expected.content, CONTENT);
});

// The two whole bot matches take about thirty seconds and run in the slow tier
// (slow/characterization-physics-bots.test.js).
test('scripted authoritative snapshots and private projections match the physics-1 checkpoint', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(await scriptedTrace(expected.arenas[4217]))), expected.scripted);
});
