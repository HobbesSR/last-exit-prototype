import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { largestRectangle, staggerStride } from '../map/micro/strategies/hall.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'hall', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides. */
const MASKS = {
  yard: [cellsOf(10, 8), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 10, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 4, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 5, length: 2 }]],
  field: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(18, 18, (x, y) => y < 9 || x < 9), [{ id: 'east', axis: 'v', x: 18, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 18, length: 3 },
    { id: 'corner', axis: 'h', x: 10, y: 9, length: 4 }]],
  ring: [cellsOf(20, 20, (x, y) => x < 6 || x >= 14 || y < 6 || y >= 14), [{ id: 'north', axis: 'h', x: 8, y: 0, length: 2 },
    { id: 'hole', axis: 'v', x: 14, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 15, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('a hall region keeps the portal promise over seeds, masks and parameters', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [undefined, { spacing: 4 }, { spacing: 7, roofed: true }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      // The yard's four portals protect nearly all of it, so it may keep none.
      if (name !== 'yard') assert.ok(result.manifest.pillars > 0, `${name} seed ${seed} stood pillars`);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
});

test('halls are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('pillars stand on the largest contained rectangle, spaced apart, and the rest stays clear', () => {
  const [cells, portals] = MASKS.ell;
  const mask = createRegionMask({ cells, cellSize: SIZE });
  assert.deepEqual(largestRectangle(mask, 6), { x: 0, y: 0, w: 18, h: 9 });
  assert.equal(largestRectangle(createRegionMask({ cells: cellsOf(20, 5), cellSize: SIZE }), 6), undefined);
  for (const spacing of [4, 6]) {
    const result = buildRegion(brief('ell', 3, cells, portals, { spacing }));
    const shapes = blockers(result);
    for (const shape of shapes) {
      const box = bounds(shape);
      assert.ok(box.y + box.h <= 9 * SIZE, 'inside the rectangle');
      // A pillar is 1½ cells, so the aisle to its neighbours is never under a doorway.
      for (const other of shapes) if (other !== shape) {
        const o = bounds(other);
        const gap = Math.max(o.x - (box.x + box.w), box.x - (o.x + o.w), o.y - (box.y + box.h), box.y - (o.y + o.h));
        assert.ok(gap >= (spacing - 1.5) * SIZE - 1e-6, `aisle ${gap / SIZE} at spacing ${spacing}`);
      }
    }
  }
});

test('the stagger breaks every sightline along its axis', () => {
  // A square deep enough for the stride to visit every phase: a period's worth of lines.
  for (const [spacing, side] of [[undefined, 24], [6, 48], [10, 110]]) {
    const cells = cellsOf(side, side);
    for (const seed of SEEDS) {
      const result = buildRegion(brief('square', seed, cells, [], spacing && { spacing }));
      const shapes = blockers(result).map(bounds);
      // Pillars on alternate lines are offset, so they don't all share one coordinate on either axis.
      const xs = new Set(shapes.map(s => s.x)), ys = new Set(shapes.map(s => s.y));
      const along = xs.size > ys.size ? 'x' : 'y', length = along === 'x' ? 'w' : 'h';
      // Every line of sight down the other axis, at each half cell, meets a pillar.
      for (let at = 3 * SIZE; at <= (side - 3) * SIZE; at += SIZE / 2)
        assert.ok(shapes.some(s => s[along] <= at && at <= s[along] + s[length]), `spacing ${spacing} seed ${seed}: line at ${at / SIZE} is blocked`);
    }
  }
});

test('the stagger stride shares no factor with the period, and stays as near half of it as that allows', () => {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  assert.deepEqual([4, 5, 6, 7, 8, 9, 10, 12].map(staggerStride), [3, 2, 5, 3, 5, 4, 7, 7]);
  for (let spacing = 4; spacing <= 40; spacing++) assert.equal(gcd(staggerStride(spacing), spacing), 1);
});

test('a roofed hall is one enclosing element over its rectangle', () => {
  const [cells, portals] = MASKS.field;
  const roofed = buildRegion(brief('field', 2, cells, portals, { roofed: true }));
  assert.equal(roofed.elements.length, 1);
  assert.equal(roofed.elements[0].template.encloses, true);
  assert.deepEqual([roofed.elements[0].x, roofed.elements[0].y, roofed.elements[0].template.w, roofed.elements[0].template.h], [0, 0, 24 * SIZE, 18 * SIZE]);
  assert.equal(roofed.manifest.structures, 1);
  const open = buildRegion(brief('field', 2, cells, portals));
  assert.equal(open.elements[0].template.encloses, undefined);
  assert.deepEqual(blockers(open), blockers(roofed));
  assert.throws(() => buildRegion(brief('field', 2, cells, portals, { spacing: 3 })), /spacing/);
  assert.throws(() => buildRegion(brief('field', 2, cells, portals, { roofed: 'yes' })), /roofed/);
});

test('every aisle is open to a contestant', () => {
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 3)) {
    const input = brief(name, seed, cells, portals, { spacing: 4 });
    input.zones[0].lootChance = 1;
    const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
    const from = portalStands(input, mask)[0].points[0];
    for (const site of result.loot.filter((_, i) => i % 7 === 0))
      assert.ok(findRegionRoute(mask, shapes, from, site, radius), `${name} ${seed}: ${site.x},${site.y} is reachable`);
  }
});

test('halls roll loot by zone and keep every site clear of pillars', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals);
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 9) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 9) }];
  const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 9 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
});

test('a hall region with no contained 6 × 6 goes to open', () => {
  const result = buildRegion(brief('thin', 1, cellsOf(20, 5), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(result.manifest.pillars, undefined);
  assert.equal(result.elements.length, 0);
});
