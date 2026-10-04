import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap, travelClear } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle } from '../shared/shape.ts';

function brief(seed, irregular = false, parameters) {
  const cells = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++)
    if (!irregular || y < 6 || x < 6) cells.push({ x, y });
  return { id: irregular ? 'ell' : 'square', seed, type: 'rubble', cellSize: 40, cells,
    zones: [{ tier: 2, bonus: 0, lootChance: 1, cells }],
    portals: irregular
      ? [{ id: 'east', axis: 'v', x: 12, y: 2, length: 2 },
        { id: 'south', axis: 'h', x: 1, y: 12, length: 3 },
        { id: 'corner', axis: 'h', x: 7, y: 6, length: 4 }]
      : [{ id: 'west', axis: 'v', x: 0, y: 2, length: 3 },
        { id: 'east', axis: 'v', x: 12, y: 2, length: 3 }],
    ...(parameters ? { parameters } : {}) };
}

const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('rubble keeps all portal stands and routes clear on rectangular and irregular masks', () => {
  assert.equal(REGION_TYPES_VERSION, 'types-10');
  for (const irregular of [false, true]) for (const seed of [1, 2, 3, 41]) {
    const input = brief(seed, irregular);
    const result = buildRegion(input);
    assert.ok(result.elements.length > 0, `seed ${seed}, irregular ${irregular}`);
    assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, [],
      `seed ${seed}, irregular ${irregular}`);
    assert.deepEqual(result.elements, buildRegion({ ...input, cells: [...input.cells].reverse() }).elements);
  }
});

test('density and squeeze share control deterministic debris', () => {
  const empty = buildRegion(brief(7, false, { density: 0 }));
  const broad = buildRegion(brief(7, false, { density: 1, squeezeShare: 0 }));
  const tight = buildRegion(brief(7, false, { density: 1, squeezeShare: 1 }));
  assert.equal(empty.elements.length, 0);
  assert.ok(broad.elements.length > 0);
  assert.equal(broad.manifest.squeezeDebris, 0);
  assert.equal(tight.manifest.squeezeDebris, tight.elements.length);
  assert.ok(tight.elements[0].template.parts[0].shape.w > broad.elements[0].template.parts[0].shape.w);
  assert.throws(() => buildRegion(brief(7, false, { squeezeShare: 2 })), /squeezeShare/);
});

test('rubble rolls loot by zone and keeps every site clear of geometry', () => {
  const input = brief(21, false, { density: 1, squeezeShare: 1 });
  const upper = input.cells.filter(c => c.y < 6), lower = input.cells.filter(c => c.y >= 6);
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: upper },
    { tier: 5, bonus: 0, lootChance: 0, cells: lower }];
  const result = buildRegion(input), mask = createRegionMask(input), obstacles = blockers(result);
  const radius = microMetrics({ cellSize: input.cellSize, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  assert.ok(result.loot.every(site => site.tier === 2 && site.y < 6 * input.cellSize));
  for (const site of result.loot) {
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(obstacles.every(shape => !shapesOverlap(disc, shape)));
  }
  assert.equal(result.manifest.loot, result.loot.length);
  const allClear = buildRegion(brief(21, false, { density: 0 }));
  assert.ok(allClear.loot.length > 64, 'no example-builder 64-site cap');
  assert.ok(allClear.loot.every(site => site.tier === 2));
});

test('a 1.5-cell rubble gap passes a contestant body and refuses a hunter body', () => {
  const input = brief(9, false, { density: 1, squeezeShare: 1 });
  const result = buildRegion(input);
  const shapes = blockers(result);
  const left = shapes.find(s => s.kind === 'rect' && s.x === 90 && s.y === 250);
  const right = shapes.find(s => s.kind === 'rect' && s.x === 170 && s.y === left?.y);
  assert.ok(left && right, 'an interior pair of lattice debris remains');
  assert.equal(right.x - (left.x + left.w), 1.5 * input.cellSize);
  const mask = createRegionMask(input), clearance = microMetrics({ cellSize: input.cellSize, bodyProfile: 'cell' }).clearance;
  const x = (left.x + left.w + right.x) / 2;
  const a = { x, y: left.y - 15 }, b = { x, y: left.y + left.h + 15 };
  assert.equal(travelClear(mask, shapes, a, b, clearance.contestant), true);
  assert.equal(travelClear(mask, shapes, a, b, clearance.hunter), false);
});

test('undersized rubble falls back to open, and one portal carries no route obligation', () => {
  const small = brief(1);
  small.cells = small.cells.filter(c => c.x < 2 && c.y < 3);
  small.zones[0].cells = small.cells;
  small.portals = [];
  assert.deepEqual(buildRegion(small).elements, []);
  const one = brief(1, false, { density: 1 });
  one.portals = one.portals.slice(0, 1);
  assert.ok(buildRegion(one).elements.length > 0);
});
