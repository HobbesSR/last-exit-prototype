import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { botTrace, seeds } from '../characterization-scenarios.js';
import { contentById } from '../../shared/simulation/content.ts';

const expected = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/behavior-netcode-1.json.gz', import.meta.url))));
// What the simulation does, run against the arenas stored in the fixture rather than freshly
// generated ones, so these keep their meaning across content changes. The map hashes and the
// scripted trace, which are cheap, stay in ../characterization.test.js.
for (const seed of seeds) test(`every bot-match tick and projection matches the netcode-1 checkpoint: seed ${seed}`, () => assert.deepEqual(botTrace(seed, expected.maps[seed], contentById('content-1')), expected.bots[seed]));
