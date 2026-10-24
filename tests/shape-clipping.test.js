import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPolygonToRect } from '../shared/shape.ts';

const vertices = points => points.map(({ x, y }) => [x, y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const area = points => points.reduce((sum, point, i) => {
  const next = points[(i + 1) % points.length];
  return sum + point.x * next.y - point.y * next.x;
}, 0) / 2;

test('clips rectangle intersection in world coordinates', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const clipped = clipPolygonToRect(square, { x: 5, y: 3, w: 10, h: 4 });
  assert.deepEqual(vertices(clipped), [[5, 3], [5, 7], [10, 3], [10, 7]]);
  assert.equal(area(clipped), 20, 'winding and area survive clipping');
});

test('returns empty outside and the box when a polygon encloses it', () => {
  const square = [{ x: -10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 20 }, { x: -10, y: 20 }];
  assert.deepEqual(clipPolygonToRect(square, { x: 30, y: 0, w: 10, h: 10 }), []);
  assert.deepEqual(vertices(clipPolygonToRect(square, { x: 2, y: 3, w: 4, h: 5 })), [[2, 3], [2, 8], [6, 3], [6, 8]]);
});

test('clips a crossing triangle without losing the new corner', () => {
  const triangle = [{ x: -5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }];
  const clipped = clipPolygonToRect(triangle, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(vertices(clipped), [[0, 0], [0, 5], [5, 0], [5, 10]]);
  assert.equal(area(clipped), 37.5);
});

test('discards edge and point contact with no area', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(clipPolygonToRect([{ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: -5, y: 10 }], box), []);
  assert.deepEqual(clipPolygonToRect([{ x: -2, y: -2 }, { x: 0, y: 0 }, { x: -2, y: 2 }], box), []);
  assert.deepEqual(clipPolygonToRect([{ x: 0, y: 0 }, { x: 1, y: 1 }], box), []);
});

test('does not mutate or alias input vertices', () => {
  const points = Object.freeze([
    Object.freeze({ x: 1, y: 1 }), Object.freeze({ x: 4, y: 1 }), Object.freeze({ x: 4, y: 4 }), Object.freeze({ x: 1, y: 4 }),
  ]);
  const box = Object.freeze({ x: 0, y: 0, w: 10, h: 10 });
  const result = clipPolygonToRect(points, box);
  assert.deepEqual(vertices(result), vertices(points));
  for (const point of result) assert.equal(points.includes(point), false);
  result[0].x = 99;
  assert.deepEqual(vertices(points), [[1, 1], [1, 4], [4, 1], [4, 4]]);
});
