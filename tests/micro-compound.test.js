import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';
import { assertWithinBudget } from './helpers/budget.js';
import { SIZE, brief, MASKS, SEEDS, build, blockers, compoundBox } from './helpers/compound-fixtures.js';
import { assertPortalPromise, assertRoofedRing, assertObservedRing } from './helpers/compound-sweeps.js';

// The fast tier runs two seeds of the portal, roofed-ring and observer sweeps; the slow tier's
// tests/slow/micro-compound-sweeps.test.js runs the first four, as these once did (31, #543).
const FAST = SEEDS.slice(0, 2);

test('a compound region keeps the portal promise over seeds, masks and gate counts', () => assertPortalPromise(FAST));

test('a hinted perimeter can hold the ring without blocking portal or gate access', () => {
  const cells = cellsOf(18, 18), portals = [{ id: 'south', axis: 'h', x: 7, y: 18, length: 3 }];
  const input = { ...brief('hinted', 3, cells, portals), hints: [{ axis: 'h', x: 0, y: 0, length: 18 }] };
  const result = build(input), box = compoundBox(result);
  assert.equal(box.y, 0);
  assert.ok(result.manifest.rooms >= 4);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
});

test('a 24 by 18 yard keeps an intermediate ring size between its portals', () => {
  const cells = cellsOf(24, 18), portals = [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
    { id: 'east', axis: 'v', x: 24, y: 8, length: 2 },
  ];
  for (const seed of [1, 2, 3, 4]) {
    const result = build(brief(`fill-${seed}`, seed, cells, portals));
    const box = compoundBox(result);
    assert.ok(box.w * box.h >= 240, `${seed}: ${box.w} by ${box.h} ring`);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
  }
});

test('compounds are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = build(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('one compound has roofed rooms around a clear court and its gates', () => assertRoofedRing(FAST));

test('compounds roll loot by zone and keep every site clear of walls and doors', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals);
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 17) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 17) }];
  const result = build(input), mask = createRegionMask(input);
  const shapes = result.elements.flatMap(element => elementShapes(element, true));
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 17 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
});

test('a compound checks its gate count, and a region too narrow for its court goes empty', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 0 })), /gates/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 5 })), /gates/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 1.5 })), /gates/);
  const thin = buildRegion(brief('thin', 1, cellsOf(40, 9), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(thin.manifest.rooms ?? 0, 0);
  assert.equal(thin.elements.length, 0);
});

test('a macro-sized compound with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals, { gates: 4 }));
  assertWithinBudget(performance.now() - started, 3000, 'macro compound built');
  const box = compoundBox(result);
  assert.deepEqual([box.w, box.h], [24, 24]);
});

test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour', () => assertObservedRing(FAST));
