import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from '../shared/core.ts';
import { coreSight } from '../shared/sight-core.ts';
import { buildCore } from '../tools/build-core.mjs';
import { emptyDigest, gateDigest, syntheticDigest } from './helpers/sight-cases.js';

// The Rust core's visibility polygons, pinned by digest (#1175, docs/27), as tests/math.test.js pins math.
// The digests were taken where the retired TypeScript `visibilityPolygon` and the core agreed bit for bit,
// so they hold the core to the polygons the game cast before the port. Every field of every point is
// mixed, signed zeros included. tests/visibility.test.js checks the polygons against an independent
// brute-force cast on the room arena; tests/sight-core.browser.mjs checks Chrome against Node.
//
// If a digest moves, the polygons moved, and with them discovery and the fixture's behaviour: that is a
// gameplay change and a fixture version decision (31), not a test update.
const core = coreSight(await loadCore(readFileSync(buildCore())));

test('the core polygons are pinned on synthetic maps, at corners, on edges and across the seam', () => {
  assert.deepEqual(syntheticDigest(core), { digest: '74451adb', polygons: 720 });
});

test('the open-gate mask follows the map each call, and a grown or copied gate list is uploaded again', () => {
  assert.deepEqual(gateDigest(core), { digest: '383d86b7', polygons: 4 });
});

test('an empty map and an empty gate list cross as empty buffers', () => {
  assert.deepEqual(emptyDigest(core), { digest: '7bea0b8e', polygons: 2 });
});
