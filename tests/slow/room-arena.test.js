import test from 'node:test';
import assert from 'node:assert/strict';
import { arenaMatches, generateArena, readArena, ARENA_FILE } from '../../tools/room-arena.mjs';
import { generatedMap } from '../helpers/room-harness.js';
import { portalGraphOf } from '../../shared/navigation/portal-graph.ts';

// Room tests play on the pregenerated arena (#849); this keeps it seed 9's live map. On failure,
// recapture it with `node tools/room-arena.mjs` in the change that moved the map.
test('the pregenerated room arena is seed 9\'s live map and portal graph', () => {
  const fresh = generateArena();
  assert.ok(arenaMatches(readArena(), fresh), `${ARENA_FILE} is behind; run node tools/room-arena.mjs`);
  const served = generatedMap(9);
  assert.deepEqual(served, structuredClone(fresh.map));
  assert.deepEqual(portalGraphOf(served), structuredClone(fresh.graph));
});
