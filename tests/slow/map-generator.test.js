import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGenerator } from '../../server/map-generator.js';
import { DEFAULT_LIVE_ZONE_SIZE } from '../../map/live.ts';
import { portalGraphOf } from '../../shared/navigation/portal-graph.ts';
import { freeSpaceTile } from '../../shared/free-space.ts';
import { discoveryGrid } from '../../shared/discovery.ts';
import { generatedMap } from '../helpers/room-harness.js';

// Moved from tests/map-generator.test.js (#849): the worker builds two game maps, slow-tier work (31).
// Seed 9's inline map is the pregenerated room arena, which tests/slow/room-arena keeps equal to generation.

test("the map worker returns exactly the map generated inline, and each request its own seed's map", async () => {
  const maps = createMapGenerator();
  try {
    const answers = Promise.all([maps.generate(4217, DEFAULT_LIVE_ZONE_SIZE), maps.generate(9, DEFAULT_LIVE_ZONE_SIZE)]);
    // Seed 9's inline map is the one this file's other tests share, generated here while the worker works, so
    // the exact comparison is seed 9's alone and costs no generation of its own. The 4217 answer is checked
    // only for being a live map of its own seed, in its own place: one seed shows the two paths agree.
    // The worker generates with the shipped content, the harness with the legacy content; their rosters are the
    // same size, so are their maps (room-content.test.js relies on this too). A roster change shows up here.
    const inline = generatedMap(9, DEFAULT_LIVE_ZONE_SIZE), [first, second] = await answers;
    assert.equal(JSON.stringify(second), JSON.stringify(inline), "the worker's map is exactly the inline one");
    assert.equal(first.generator, inline.generator, 'the earlier request is answered with a live map');
    assert.deepEqual([first.seed, second.seed], [4217, 9], "each request is answered with its own seed's map, in its own order");
    assert.notEqual(JSON.stringify(first), JSON.stringify(inline), 'and not with a copy of another');
    assert.deepEqual(portalGraphOf(second), portalGraphOf(inline), 'the portal graph crosses beside the map');
    // A gladiator's tiles cross too, packed (22.6, "Bot adoption"): read from one buffer, equal to those built inline.
    const { cols, size } = discoveryGrid(inline), boxOf = cell => ({ x: (cell % cols) * size, y: Math.floor(cell / cols) * size, w: size, h: size });
    const crossed = [cols * 3 + 5, cols * 5 + 40, cols * 10 + 90].map(cell => freeSpaceTile(second, boxOf(cell), 25));
    assert.ok(crossed.every(t => t.points.buffer === crossed[0].points.buffer), 'one packed buffer, not tiles built here');
    crossed.forEach((tile, i) => assert.deepEqual(tile, freeSpaceTile(inline, tile.box, 25), `tile ${i}`));
  } finally { await maps.close(); }
});
