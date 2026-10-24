import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyRadius, bodyShape } from '../shared/physics/presentation-geometry.ts';
import { outline } from '../shared/shape.ts';
import { seesShape, createShapeVisibility } from '../shared/view.ts';

const eye = { x: 0, y: 0 };
const corners = [{ x: -10, y: -10 }, { x: 10, y: -10 },
  { x: 10, y: 10 }, { x: -10, y: 10 }];
const sight = { eye, bounds: { x: -10, y: -10, width: 20, height: 20 },
  points: corners.map(point => ({ ...point, angle: Math.atan2(point.y, point.x), length: Math.hypot(point.x, point.y) })) };
const map = { buildings: [] };
const body = (x, y, shape, angle = 0) => ({ x, y, shape, angle });
const seesBody = (sight, map, value) => seesShape(sight, map, bodyShape(value));

test('body radius and rotated vertices share the renderer geometry', () => {
  assert.equal(bodyRadius({ kind: 'circle', radius: 7 }), 7);
  assert.equal(bodyRadius({ kind: 'box', hx: 3, hy: 4 }), 5);
  assert.equal(bodyRadius({ kind: 'convex', vertices: [{ x: -3, y: 0 }, { x: 0, y: 4 }, { x: 2, y: 0 }] }), 4);
  const vertices = outline(bodyShape(body(12, 0, { kind: 'box', hx: 2, hy: 5 }, Math.PI / 4)));
  assert.ok(vertices.some(point => point.x < 10));
});

test('visible body edge is enough, but an occluded body never enters sight', () => {
  assert.equal(seesBody(sight, map, body(12, 0, { kind: 'circle', radius: 3 })), true);
  assert.equal(seesBody(sight, map, body(12, 0, { kind: 'box', hx: 2, hy: 5 }, Math.PI / 4)), true);
  assert.equal(seesBody(sight, map, body(12, 0, { kind: 'convex', vertices: [{ x: -4, y: 0 }, { x: 2, y: -2 }, { x: 2, y: 2 }] })), true);
  assert.equal(seesBody(sight, map, body(20, 0, { kind: 'circle', radius: 3 })), false);
  assert.equal(seesBody(sight, map, body(20, 0, { kind: 'box', hx: 2, hy: 5 }, Math.PI / 4)), false);
  assert.equal(seesBody(sight, map, body(13, 0, { kind: 'circle', radius: 3 })), true, 'true circle tangency is not a polygon approximation');
});

test('camera coverage and center roof concealment still restrict props', () => {
  const away = { ...sight, bounds: { x: -100, y: -100, width: 10, height: 10 } };
  assert.equal(seesBody(away, map, body(12, 0, { kind: 'circle', radius: 3 })), false);
  const edgeViewport = { ...sight, bounds: { x: -100, y: -5, width: 10, height: 10 },
    points: corners.map(point => ({ x: point.x * 10, y: point.y * 10,
      angle: Math.atan2(point.y, point.x), length: Math.hypot(point.x, point.y) * 10 })) };
  assert.equal(seesBody(edgeViewport, map, body(-50, 0, { kind: 'circle', radius: 20 })), true);
  assert.equal(seesBody(null, map, body(0, 0, { kind: 'circle', radius: 3 })), false);
  const roofMap = { buildings: [{ id: 'covered', x: 11, y: -10, w: 20, h: 20 }] };
  assert.equal(seesBody(sight, roofMap, body(12, 0, { kind: 'circle', radius: 3 })), false);
});

test('one prepared frame handles many shapes and rejects disjoint sight/camera intersections', () => {
  const query = createShapeVisibility(sight, map);
  for (const x of [12, 20, 0, 13, -12]) {
    const shape = bodyShape(body(x, 0, { kind: 'circle', radius: 3 }));
    assert.equal(query(shape), seesShape(sight, map, shape));
  }
  const disjoint = { ...sight, bounds: { x: -100, y: -5, width: 10, height: 10 } };
  assert.equal(seesBody(disjoint, map, body(-25, 0, { kind: 'circle', radius: 40 })), false,
    'intersecting sight and camera separately cannot grant visibility');
  const buried = { ...sight, points: sight.points.map(p => ({ ...p, x: 0, y: 0 })) };
  assert.equal(seesBody(buried, map, body(0, 0, { kind: 'circle', radius: 3 })), false);
});
