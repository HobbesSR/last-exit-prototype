import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, rect } from '../shared/shape.ts';
import { createRegionMask, shapesOverlap } from '../shared/map/micro/geometry.ts';
import { spreadPoints } from '../shared/map/micro/placement.ts';

const mask = (width, height, keep = () => true) => createRegionMask({ cellSize: 40,
  cells: Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => ({ x, y })).filter(({ x, y }) => keep(x, y))).flat(),
});
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('spreads points deterministically and independently of cell or exclusion ordering', () => {
  const cells = mask(12, 8), blockers = [rect(200, 80, 40, 160), rect(40, 40, 30, 30)];
  const first = spreadPoints(cells, { count: 12, radius: 12, blockers });
  const reversed = createRegionMask({ cellSize: 40, cells: [...cells.cells].reverse() });
  const second = spreadPoints(reversed, { count: 12, radius: 12, blockers: [...blockers].reverse() });
  assert.deepEqual(second, first);
  assert.equal(first.shortfall, 0);
  assert.ok(first.minimumSpacing >= 24);
  for (let i = 0; i < first.points.length; i++) for (let j = 0; j < i; j++) assert.ok(distance(first.points[i], first.points[j]) >= 24);
});

test('seeded ties produce distinct, deterministic layouts without changing clearance', () => {
  const region = mask(12, 8), options = { count: 12, radius: 12, seed: 71 };
  const first = spreadPoints(region, options), repeated = spreadPoints(region, options);
  const varied = spreadPoints(region, { ...options, seed: 72 });
  assert.deepEqual(repeated, first);
  assert.notDeepEqual(varied.points, first.points, 'different seeds must select different geometry, not only different metadata');
  for (const points of [first.points, varied.points]) for (let i = 0; i < points.length; i++) for (let j = 0; j < i; j++) assert.ok(distance(points[i], points[j]) >= 24);
});

test('keeps discs out of holes, blockers, and reservations', () => {
  const region = mask(10, 8, (x, y) => x < 4 || y < 2 || y > 5);
  const blockers = [rect(40, 40, 80, 80)], reservations = [rect(0, 240, 120, 40)];
  const result = spreadPoints(region, { count: 10, radius: 10, blockers, reservations });
  for (const point of result.points) {
    const disc = circle(point.x, point.y, 10);
    assert.equal(region.contains(disc), true);
    assert.equal([...blockers, ...reservations].some(shape => shapesOverlap(disc, shape)), false);
  }
});

test('reports an explicit shortfall when capacity cannot meet the request', () => {
  const result = spreadPoints(mask(2, 2), { count: 8, radius: 18 });
  assert.ok(result.points.length < 8);
  assert.equal(result.shortfall, result.requested - result.points.length);
  assert.ok(result.minimumSpacing === null || result.minimumSpacing >= 36);
});

test('anchor routing rejects an otherwise clear disconnected area', () => {
  const region = mask(6, 3);
  const wall = rect(112, 0, 16, 120);
  const result = spreadPoints(region, { count: 16, radius: 10, blockers: [wall], anchor: { x: 20, y: 60 } });
  assert.ok(result.points.every(point => point.x < 112), 'points beyond the sealed wall must be rejected');
});

test('rejects invalid placement inputs', () => {
  const region = mask(2, 2);
  for (const options of [
    { count: -1, radius: 10 }, { count: 65, radius: 10 }, { count: 1.5, radius: 10 },
    { count: 1, radius: 0 }, { count: 1, radius: NaN }, { count: 1, radius: 10, anchor: { x: Infinity, y: 0 } },
    { count: 1, radius: 10, anchor: { x: 5, y: 5 } },
    { count: 1, radius: 10, seed: 1.5 },
  ]) assert.throws(() => spreadPoints(region, options));
});
