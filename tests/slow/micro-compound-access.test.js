import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../../map/micro/geometry.ts';
import { hunterClearance, portalStands } from '../../map/micro/portals.ts';
import { microMetrics } from '../../map/micro/metrics.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) =>
  ({ x: n % w, y: Math.floor(n / w) })).filter(cell => keep(cell.x, cell.y));
const brief = (id, seed, cells, portals, gates) => ({ id, seed, type: 'compound', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals, parameters: { gates } });
const MASKS = {
  yard: [cellsOf(17, 16), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 17, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 16, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(40, 40, (x, y) => y < 20 || x < 20), [{ id: 'east', axis: 'v', x: 40, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 40, length: 4 },
    { id: 'corner', axis: 'h', x: 24, y: 20, length: 6 }]],
  ring: [cellsOf(46, 46, (x, y) => x < 17 || x >= 29 || y < 17 || y >= 29), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 29, y: 20, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 34, length: 3 }]],
};
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
const inside = (site, box) => site.x > box.x * SIZE && site.x < (box.x + box.w) * SIZE && site.y > box.y * SIZE && site.y < (box.y + box.h) * SIZE;
const compoundBox = elements => {
  const boxes = elements.map(cellBox);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};

test('every room and the court are open through compound gates across masks and gate counts', () => {
  const hunter = hunterClearance(SIZE), contestant = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const [seed, gates] of [[1, 1], [2, 3]]) {
    const input = brief(name, seed, cells, portals, gates);
    const result = buildRegion(input), access = createAccessMask(input), shapes = result.elements.flatMap(element => elementShapes(element));
    const from = portalStands(input)[0].points[0];
    const ring = result.elements.filter(element => /^compound-(room|gate)/.test(element.label));
    const rooms = ring.filter(element => element.label.startsWith('compound-room')).map(cellBox);
    const box = compoundBox(ring), court = { x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 };
    for (const room of rooms) {
      const site = result.loot.find(site => inside(site, room));
      assert.ok(site, `${name} ${seed}: loot in the room at ${room.x},${room.y}`);
      assert.ok(findRegionRoute(access, shapes, from, site, hunter), `${name} ${seed}: a hunter reaches ${site.x},${site.y}`);
    }
    const courtSites = result.loot.filter(site => inside(site, court));
    assert.ok(courtSites.length > 0);
    for (const site of courtSites.filter((_, i) => i % 5 === 0))
      assert.ok(findRegionRoute(access, shapes, from, site, contestant), `${name} ${seed}: the court at ${site.x},${site.y}`);
  }
});
