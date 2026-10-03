import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { circle } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals = [], extra = {}) => ({
  id, seed, type: 'arrival', cellSize: SIZE, cells,
  zones: [{ tier: 2, bonus: 0, lootChance: 1, cells }], portals,
  coreElements: { spawn: 8 }, ...extra,
});
const blockersOf = result => result.elements.flatMap(elementShapes);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('arrival sites its requested spawns before cover and loot, with physical clearance', () => {
  const cells = cellsOf(30, 24);
  const result = buildRegion(brief('field', 7, cells, [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 4 },
    { id: 'east', axis: 'v', x: 30, y: 8, length: 4 },
  ]));
  const { clearance, lootRadius } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' });
  const mask = createRegionMask(result.brief), blockers = blockersOf(result);
  assert.equal(result.version, 'region-2');
  assert.equal(result.coreElements.length, 8);
  assert.ok(result.coreElements.every(site => site.kind === 'spawn'));
  assert.equal(result.manifest.coreElements, 8);
  assert.ok(result.elements.length > 0, 'the fixture exercises cover clearance');
  assert.ok(result.loot.length > 0, 'the fixture exercises loot clearance');
  assert.equal(result.manifest.loot, result.loot.length);
  for (const site of result.coreElements) {
    const stand = circle(site.x, site.y, clearance.contestant);
    assert.ok(mask.contains(stand), `spawn ${site.x},${site.y} fits inside owned cells`);
    assert.ok(blockers.every(shape => !shapesOverlap(stand, shape)), `cover clears spawn ${site.x},${site.y}`);
    assert.ok(result.loot.every(loot => !shapesOverlap(stand, circle(loot.x, loot.y, lootRadius))), `loot clears spawn ${site.x},${site.y}`);
  }
  for (let i = 0; i < result.coreElements.length; i++) for (let j = 0; j < i; j++)
    assert.ok(distance(result.coreElements[i], result.coreElements[j]) >= 2 * clearance.contestant - 1e-6, 'spawn bodies do not overlap');
});

test('arrival spreads spawns deterministically and honors a requested spacing', () => {
  const cells = cellsOf(40, 30);
  const input = brief('spread', 13, cells, [], { parameters: { spacing: 6 } });
  const result = buildRegion(input);
  assert.deepEqual(buildRegion(input), result);
  assert.equal(result.coreElements.length, 8);
  for (let i = 0; i < result.coreElements.length; i++) for (let j = 0; j < i; j++)
    assert.ok(distance(result.coreElements[i], result.coreElements[j]) >= 6 * SIZE - 1e-6, 'spacing is measured in cells');
  const xs = result.coreElements.map(site => site.x), ys = result.coreElements.map(site => site.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 20 * SIZE, 'sites span the region width');
  assert.ok(Math.max(...ys) - Math.min(...ys) >= 12 * SIZE, 'sites span the region height');
  assert.notDeepEqual(buildRegion({ ...input, seed: 14 }).coreElements, result.coreElements, 'seed affects equally good layouts');
});

test('arrival reports an impossible spacing as fewer placed sites', () => {
  const cells = cellsOf(12, 12);
  const requested = 4;
  const result = buildRegion(brief('small', 5, cells, [], {
    coreElements: { spawn: requested }, parameters: { spacing: 20 },
  }));
  assert.ok(result.coreElements.length > 0 && result.coreElements.length < requested);
  assert.equal(result.manifest.coreElements, result.coreElements.length);
  assert.ok(result.coreElements.every(site => site.kind === 'spawn'));
});

test('arrival keeps the whole-portal promise over seeds and shaped masks', () => {
  const masks = [
    ['ell', cellsOf(30, 30, (x, y) => y < 15 || x < 15), [
      { id: 'east', axis: 'v', x: 30, y: 4, length: 3 },
      { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
      { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 },
    ]],
    ['ring', cellsOf(32, 32, (x, y) => x < 10 || x >= 22 || y < 10 || y >= 22), [
      { id: 'north', axis: 'h', x: 12, y: 0, length: 5 },
      { id: 'hole', axis: 'v', x: 22, y: 14, length: 4 },
      { id: 'south', axis: 'h', x: 3, y: 32, length: 3 },
    ]],
  ];
  for (const [name, cells, portals] of masks) for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(name, seed, cells, portals));
    const check = validatePortalReach({ ...result.brief, blockers: blockersOf(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
    assert.equal(result.coreElements.length, 8, `${name} seed ${seed} spawn count`);
  }
});
