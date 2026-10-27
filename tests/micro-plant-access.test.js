import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createRegionMask, findRegionRoute } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { SIZE, brief, MASKS, SEEDS, blockers, kind, gapOf } from './helpers/plant-fixtures.js';
import { standNear } from './helpers/stands.js';

test('a hunter passes every pipe gap, and a contestant reaches every loot site, indoors and out', () => {
  const { hunter, contestant } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance;
  let gaps = 0;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) {
    const input = brief(name, seed, cells, portals, { density: 1, shed: 1 });
    input.zones[0].lootChance = 1;
    const result = buildRegion(input), mask = createRegionMask(input), access = createAccessMask(input), shapes = blockers(result);
    const near = standNear(input);
    // A cell either side of each gap's middle, both reached by a hunter.
    for (const pipe of result.elements.filter(kind('pipe'))) {
      const { across, free: [[start, end]] } = gapOf(pipe), middle = (start + end) / 2 + 0.5;
      const centre = across ? { x: pipe.x + middle * SIZE, y: pipe.y + SIZE / 2 } : { x: pipe.x + SIZE / 2, y: pipe.y + middle * SIZE };
      for (const side of [-1, 1]) {
        gaps++;
        const point = across ? { x: centre.x, y: centre.y + side * SIZE } : { x: centre.x + side * SIZE, y: centre.y };
        assert.ok(findRegionRoute(access, shapes, near(point), point, hunter), `${name} ${seed}: ${pipe.label} side ${side}`);
      }
    }
    const every = Math.ceil(result.loot.length / 30);
    const shed = result.elements.find(kind('shed'));
    const inside = site => shed && site.x > shed.x && site.x < shed.x + shed.template.w && site.y > shed.y && site.y < shed.y + shed.template.h;
    for (const site of result.loot.filter((site, i) => inside(site) || i % every === 0))
      assert.ok(findRegionRoute(access, shapes, near(site), site, contestant), `${name} ${seed}: ${site.x},${site.y} is reachable`);
  }
  assert.ok(gaps > 20, `${gaps} gap sides`);
});
