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
  id, seed, type: 'charging', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals,
  coreElements: { charger: 1 }, ...extra,
});
const blockersOf = result => result.elements.flatMap(elementShapes);
const chargers = result => result.coreElements.filter(site => site.kind === 'charger');

/** The charger fits, its standing room is clear of cover and loot, cover stands near, and a contestant can walk to it. */
function assertStation(result, label, standing = 2, expectCover = true) {
  const mask = createRegionMask(result.brief), blockers = blockersOf(result);
  const root = portalStands(result.brief, mask).find(portal => portal.points.length)?.points[0];
  assert.equal(chargers(result).length, 1, `${label}: one charger`);
  assert.equal(result.manifest.coreElements, 1);
  for (const charger of chargers(result)) {
    assert.ok(mask.contains(circle(charger.x, charger.y, clearance.contestant)), `${label}: the charger fits inside owned cells`);
    const room = circle(charger.x, charger.y, standing * SIZE);
    assert.ok(blockers.every(shape => !shapesOverlap(room, shape)), `${label}: cover clears the standing room`);
    assert.ok(result.loot.every(loot => !shapesOverlap(room, circle(loot.x, loot.y, lootRadius))), `${label}: loot clears the standing room`);
    if (expectCover) assert.ok(blockers.some(shape => shapesOverlap(circle(charger.x, charger.y, (standing + 2) * SIZE), shape)), `${label}: cover stands near the standing room`);
    if (root) assert.ok(findRegionRoute(mask, blockers, root, charger, clearance.contestant), `${label}: the charger is reached from the first portal`);
  }
}

test('charging sites one charger in the middle, with clear standing room and cover beside it', () => {
  const result = buildRegion(brief('pad', 7, cellsOf(24, 20), [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 4 },
    { id: 'north', axis: 'h', x: 16, y: 0, length: 3 },
  ]));
  assert.equal(result.version, 'region-2');
  const [charger] = chargers(result);
  assert.ok(Math.abs(charger.x - 12 * SIZE) <= SIZE && Math.abs(charger.y - 10 * SIZE) <= SIZE, 'the charger stands near the middle');
  assert.ok(result.loot.length > 0, 'the fixture exercises loot clearance');
  assert.equal(result.manifest.obstacles, result.elements.length);
  assertStation(result, 'pad');
});

test('charging adds cover beside the station when the scatter leaves none near', () => {
  // Density 0 scatters nothing, so any cover is the guard piece.
  const result = buildRegion(brief('bare', 3, cellsOf(20, 20), [{ id: 'west', axis: 'v', x: 0, y: 2, length: 3 }], { parameters: { density: 0 } }));
  assert.equal(result.elements.length, 1);
  assertStation(result, 'bare');
  const seeds = new Set([3, 4, 5, 6, 7].map(seed => JSON.stringify(buildRegion(brief('bare', seed, cellsOf(20, 20), [], { parameters: { density: 0 } })).elements)));
  assert.ok(seeds.size > 1, 'the seed chooses among places for the guard');
});

test('charging honours its standing parameter, deterministically', () => {
  const input = brief('wide', 13, cellsOf(30, 30), [], { parameters: { standing: 4 } });
  const result = buildRegion(input);
  assert.deepEqual(buildRegion(input), result);
  assertStation(result, 'wide', 4);
  assert.throws(() => buildRegion(brief('bad', 5, cellsOf(10, 10), [], { parameters: { standing: 0 } })), /standing must be a positive number/);
});

test('a small pad holds its charger and leaves cover to its neighbours', () => {
  // The fixture's charger pad is 2 × 2 cells, with a portal on one side.
  const result = buildRegion(brief('fixture-pad', 1, cellsOf(2, 2), [{ id: 'east', axis: 'v', x: 2, y: 0, length: 2 }]));
  assertStation(result, 'fixture-pad', 2, false);
  assert.deepEqual(result.elements, []);
  const none = buildRegion(brief('sliver', 1, cellsOf(1, 4)));
  assert.equal(chargers(none).length, 0, 'no room for a contestant leaves the shortfall for the report');
  assert.equal(none.manifest.coreElements, 0);
});

test('charging keeps the whole-portal promise over seeds and shaped masks', () => {
  const masks = [
    ['ell', cellsOf(26, 26, (x, y) => y < 13 || x < 13), [
      { id: 'east', axis: 'v', x: 26, y: 4, length: 3 },
      { id: 'south', axis: 'h', x: 2, y: 26, length: 4 },
      { id: 'corner', axis: 'h', x: 16, y: 13, length: 6 },
    ]],
    ['ring', cellsOf(30, 30, (x, y) => x < 10 || x >= 20 || y < 10 || y >= 20), [
      { id: 'north', axis: 'h', x: 12, y: 0, length: 5 },
      { id: 'hole', axis: 'v', x: 20, y: 14, length: 4 },
      { id: 'south', axis: 'h', x: 3, y: 30, length: 3 },
    ]],
  ];
  for (const [name, cells, portals] of masks) for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(name, seed, cells, portals));
    const check = validatePortalReach({ ...result.brief, blockers: blockersOf(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
    assertStation(result, `${name} seed ${seed}`);
  }
});

test('a charger the first portal cannot reach moves to where a contestant can', () => {
  // A big room joined to the portal's small room by a one-cell neck no contestant passes.
  const cells = cellsOf(31, 12, (x, y) => x < 8 && y < 8 || x === 8 && y === 3 || x > 8);
  const result = buildRegion(brief('neck', 2, cells, [{ id: 'west', axis: 'v', x: 0, y: 2, length: 3 }]));
  const [charger] = chargers(result);
  assert.ok(charger.x < 8 * SIZE, 'the charger stays on the portal side of the neck');
  assertStation(result, 'neck', 2, false);
});
