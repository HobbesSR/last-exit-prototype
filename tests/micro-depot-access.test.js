import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { cellsOf } from './helpers/cells.js';
import { standNear } from './helpers/stands.js';

const SIZE = 40;
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'depot', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals, parameters });
const MASKS = {
  yard: [cellsOf(14, 12), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 14, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 12, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};

test('every depot aisle is open to a contestant, indoors and out', () => {
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3])
    for (const roomCells of [6, 9]) {
      const input = brief(name, seed, cells, portals, { density: 1, roomCells });
      const result = buildRegion(input), access = createAccessMask(input);
      const shapes = result.elements.flatMap(element => elementShapes(element));
      const near = standNear(input);
      // Every site in the first warehouse tests its doors and shelves, plus a sample outdoors.
      const first = result.elements.find(element => element.label.startsWith('depot-warehouse'));
      const indoors = first ? result.loot.filter(site => site.x > first.x && site.x < first.x + first.template.w
        && site.y > first.y && site.y < first.y + first.template.h) : [];
      if (first) assert.ok(indoors.length > 0, `${name} ${seed}: loot indoors`);
      const every = Math.ceil(result.loot.length / 8);
      for (const site of [...indoors, ...result.loot.filter((_, i) => i % every === 0)])
        assert.ok(findRegionRoute(access, shapes, near(site), site, radius), `${name} ${seed}: ${site.x},${site.y} is reachable`);
    }
});
