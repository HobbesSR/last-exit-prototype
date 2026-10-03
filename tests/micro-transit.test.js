import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { circle } from '../shared/shape.ts';

const SIZE = 40;
const { clearance, lootRadius } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' });
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals = [], extra = {}) => ({
  id, seed, type: 'transit', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals,
  coreElements: { warp: 1 }, ...extra,
});

function assertTransit(result, label) {
  const mask = createRegionMask(result.brief), blockers = result.elements.flatMap(elementShapes);
  const root = portalStands(result.brief, mask).find(portal => portal.points.length)?.points[0];
  const sites = result.coreElements.filter(site => site.kind === 'warp');
  assert.equal(sites.length, 1, `${label}: one warp`);
  assert.equal(result.manifest.coreElements, 1);
  const [site] = sites;
  assert.ok(mask.contains(circle(site.x, site.y, clearance.hunter)), `${label}: hunter stands in region`);
  const room = circle(site.x, site.y, 2 * SIZE);
  assert.ok(blockers.every(shape => !shapesOverlap(room, shape)), `${label}: standing room clear of cover`);
  assert.ok(result.loot.every(loot => !shapesOverlap(room, circle(loot.x, loot.y, lootRadius))), `${label}: standing room clear of loot`);
  if (root) assert.ok(findRegionRoute(mask, blockers, root, site, clearance.hunter), `${label}: hunter reaches warp from first portal`);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers }).errors, [], `${label}: portal promise`);
}

test('transit sites one hunter reachable warp in shaped masks over seeds', () => {
  const masks = [
    ['rect', cellsOf(12, 12), [{ id: 'west', axis: 'v', x: 0, y: 3, length: 3 }]],
    ['ell', cellsOf(20, 20, (x, y) => y < 10 || x < 10), [
      { id: 'east', axis: 'v', x: 20, y: 3, length: 3 },
      { id: 'south', axis: 'h', x: 3, y: 20, length: 3 },
    ]],
    ['neck', cellsOf(31, 12, (x, y) => x < 8 && y < 8 || x === 8 && y === 3 || x > 8), [
      { id: 'west', axis: 'v', x: 0, y: 2, length: 3 },
    ]],
  ];
  for (const [name, cells, portals] of masks) for (const seed of [1, 2, 3, 7]) {
    const input = brief(name, seed, cells, portals);
    const result = buildRegion(input);
    assert.deepEqual(buildRegion(input), result, `${name} seed ${seed}: deterministic`);
    assertTransit(result, `${name} seed ${seed}`);
    if (name === 'neck') assert.ok(result.coreElements[0].x < 8 * SIZE, 'warp stays on portal side of hunter impassable neck');
  }
});

test('transit leaves a shortfall when a hunter cannot fit', () => {
  const result = buildRegion(brief('sliver', 1, cellsOf(1, 4)));
  assert.deepEqual(result.coreElements, []);
  assert.equal(result.manifest.coreElements, 0);
  assert.throws(() => buildRegion(brief('bad', 1, cellsOf(6, 6), [], { parameters: { standing: 0 } })), /standing must be a positive number/);
});
