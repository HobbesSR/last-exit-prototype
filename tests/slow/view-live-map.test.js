import test from 'node:test';
import assert from 'node:assert/strict';
import { roofConceals, roofGroups } from '../../shared/view.ts';
import { generateLiveMap } from '../../map/live.ts';

// Moved from tests/view.test.js (#849): it builds two live maps, so it is slow-tier work (31).

const SHARED_ID_FIELDS = [
  ['buildings', /^building-(\d+)$/],
  ['obstacles', /^o(\d+)$/],
  ['gates', /^door-(\d+)$/],
  ['chargers', /^charger-(\d+)$/],
  ['stations', /^rail-(\d+)$/],
  ['items', /^item-(\d+)$/],
  ['sensors', /^sensor-(\d+)$/],
  ['traps', /^trap-(\d+)$/],
];

test('live map: roofs have unique ids, take no shared serials, and declare multi-room groups', () => {
  // Roofs use placement-scoped ids (`building-*` or `roofs-*.*`) rather than the shared `nextId`
  // serial, so roof creation leaves no gaps in building/obstacle/gate/charger/station/item serials (#343, #1135).
  const maps = [1, 2].map(seed => ({ seed, map: generateLiveMap(seed) }));

  assert.ok(maps.some(({ map }) => [...roofGroups(map).values()].some(group => group.length > 1)),
    'the live-map sample declares a multi-room group');

  for (const { seed, map } of maps) {
    const serials = [];
    for (const [field, pattern] of SHARED_ID_FIELDS) {
      for (const entry of map[field] ?? []) {
        const match = pattern.exec(entry.id);
        assert.ok(match, `seed ${seed} ${field} entry has unexpected id ${entry.id}`);
        serials.push(Number(match[1]));
      }
    }
    serials.sort((a, b) => a - b);
    assert.ok(serials.length > 0, `seed ${seed} generated shared-serial entities`);
    const gapIndex = serials.findIndex((n, i) => n !== i);
    assert.equal(gapIndex, -1,
      `seed ${seed} shared ID serials have no gap or duplicate (index ${gapIndex}, got ${serials[gapIndex]})`);

    for (const roof of map.roofs) {
      const owned = roof.buildingId && (roof.id === roof.buildingId || roof.id.startsWith(`${roof.buildingId}.`));
      assert.ok(owned || /^roofs-\d+\./.test(roof.id),
        `seed ${seed} roof ${roof.id} stays in the placement-scoped roof id space`);
    }

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
