import test from 'node:test';
import assert from 'node:assert/strict';
import { roofConceals, roofGroups } from '../../shared/view.ts';
import { generateLiveMap } from '../../map/live.ts';

// Moved from tests/view.test.js (#849): it builds two live maps, so it is slow-tier work (31).

test('live map: roofs have unique ids, keep map id order, and declare multi-room groups', () => {
  // #530's grounds, infill, #534's market, #647's yards, #532's structures, #533's warehouses/winged library, #717's fallback, #750's cord-routed park and #759/#760's cord-routed rubble and plant and park fronts, #787's cord-routed cover, ruins, depot and hall, #849's matched libraries with cover and park edge walls, #857's placement lookahead (seed 2's layout) and #895's sparse-sides libraries change counts.
  // Pin the resulting map IDs so roof creation cannot renumber obstacles, gates or items (#343).
  const map1 = generateLiveMap(1);
  assert.equal(map1.obstacles?.at(-1)?.id, 'o3709', 'obstacle IDs stay pinned on seed 1');
  assert.equal(map1.gates?.at(-1)?.id, 'door-2269', 'gate IDs stay pinned on seed 1');
  assert.equal(map1.items?.at(-1)?.id, 'item-4559', 'item IDs stay pinned on seed 1');

  const map2 = generateLiveMap(2);
  assert.equal(map2.obstacles?.at(-1)?.id, 'o3610', 'obstacle IDs stay pinned on seed 2');
  assert.equal(map2.gates?.at(-1)?.id, 'door-2203', 'gate IDs stay pinned on seed 2');
  assert.equal(map2.items?.at(-1)?.id, 'item-4530', 'item IDs stay pinned on seed 2');

  assert.ok([map1, map2].some(map => [...roofGroups(map).values()].some(group => group.length > 1)),
    'the live-map sample declares a multi-room group');

  for (const map of [map1, map2]) {
    const ids = new Set(map.roofs.map(r => r.id));
    assert.equal(ids.size, map.roofs.length, 'all roof ids are distinct across the live map');

    const samplePoints = map.roofs.map(r => ({
      id: r.id,
      pt: {
        x: r.origin.x + (r.cells[0].x + 0.5) * r.cellSize,
        y: r.origin.y + (r.cells[0].y + 0.5) * r.cellSize,
      },
    }));

    for (let i = 0; i < Math.min(samplePoints.length, 20); i++) {
      for (let j = i + 1; j < Math.min(samplePoints.length, 20); j++) {
        const a = samplePoints[i], b = samplePoints[j];
        assert.equal(roofConceals(map, a.pt, b.pt), true, `roof ${a.id} conceals roof ${b.id}`);
        assert.equal(roofConceals(map, b.pt, a.pt), true, `roof ${b.id} conceals roof ${a.id}`);
      }
    }
  }
});
