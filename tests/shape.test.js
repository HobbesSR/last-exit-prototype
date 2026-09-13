import test from 'node:test';
import assert from 'node:assert/strict';
import { rect, circle, polygon, shapeOf, bounds, nearBounds, outline, edgesOf, body, contains, overlaps, transform, convex, CIRCLE_SEGMENTS } from '../shared/shape.ts';
import { canOccupy, lineClear, movePlayer } from '../shared/movement.ts';

const square = [{ x: -30, y: -30 }, { x: 30, y: -30 }, { x: 30, y: 30 }, { x: -30, y: 30 }];

test('a stored record resolves to whichever of the three forms it describes', () => {
  assert.deepEqual(shapeOf({ x: 10, y: 20, w: 30, h: 40 }), rect(10, 20, 30, 40));
  assert.deepEqual(shapeOf({ x: 10, y: 20, w: 0, h: 0, r: 15 }), circle(10, 20, 15));
  assert.deepEqual(shapeOf({ x: 10, y: 20, w: 0, h: 0, points: square }), polygon(10, 20, square));
  // A radius wins over the box fields the record still carries, as the collision code always assumed.
  assert.equal(shapeOf({ x: 0, y: 0, w: 99, h: 99, r: 5 }).kind, 'circle');
});

test('bounds and the broad-phase test agree for every form', () => {
  assert.deepEqual(bounds(rect(10, 20, 30, 40)), { x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(bounds(circle(100, 100, 25)), { x: 75, y: 75, w: 50, h: 50 });
  assert.deepEqual(bounds(polygon(100, 100, square)), { x: 70, y: 70, w: 60, h: 60 });
  // The circle case must keep the old inline meaning: |dx| <= radius + r.
  const box = bounds(circle(100, 100, 25));
  assert.equal(nearBounds(box, 130, 100, 5), true);
  assert.equal(nearBounds(box, 131, 100, 5), false);
  assert.equal(nearBounds(box, 100, 100, 0), true);
});

test('a circle outlines as the same sixteen-gon the sight edges were always built from', () => {
  const points = outline(circle(0, 0, 10));
  assert.equal(points.length, CIRCLE_SEGMENTS);
  // Frozen against the previous inline expression: cos/sin of i * PI / 8, starting at angle zero.
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    assert.ok(Math.abs(points[i].x - Math.cos(i * Math.PI / 8) * 10) < 1e-12);
    assert.ok(Math.abs(points[i].y - Math.sin(i * Math.PI / 8) * 10) < 1e-12);
  }
  // A rect winds from its top-left corner, and edges close the loop.
  assert.deepEqual(outline(rect(0, 0, 4, 2)), [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }]);
  const edges = edgesOf(rect(0, 0, 4, 2));
  assert.equal(edges.length, 4);
  assert.deepEqual(edges[3], { a: { x: 0, y: 2 }, b: { x: 0, y: 0 } });
});

test('point containment and overlap work across every pair of forms', () => {
  assert.equal(contains(rect(0, 0, 10, 10), 5, 5), true);
  assert.equal(contains(rect(0, 0, 10, 10), 11, 5), false);
  assert.equal(contains(circle(0, 0, 10), 8, 8), false, 'a corner of the bounding box is outside the circle');
  assert.equal(contains(circle(0, 0, 10), 6, 6), true);
  assert.equal(contains(polygon(100, 100, square), 100, 100), true);
  assert.equal(contains(polygon(100, 100, square), 140, 100), false);

  const near = polygon(100, 100, square), far = polygon(400, 400, square);
  assert.equal(overlaps(circle(120, 100, 15), near), true);
  assert.equal(overlaps(circle(200, 100, 15), near), false);
  assert.equal(overlaps(rect(95, 95, 10, 10), near), true);
  assert.equal(overlaps(near, rect(95, 95, 10, 10)), true, 'overlap is symmetric across kinds');
  assert.equal(overlaps(near, far), false);
  assert.equal(overlaps(circle(0, 0, 10), circle(15, 0, 10)), true);
});

test('transform moves a shape and rotates it about its own anchor', () => {
  assert.deepEqual(transform(rect(10, 10, 5, 5), 5, -5), rect(15, 5, 5, 5));
  assert.deepEqual(transform(circle(10, 10, 3), 0, 4), circle(10, 14, 3));
  // A rotated box can no longer be axis aligned, so it becomes a polygon of the same size.
  const turned = transform(rect(0, 0, 10, 4), 0, 0, Math.PI / 2);
  assert.equal(turned.kind, 'polygon');
  const box = bounds(turned);
  assert.ok(Math.abs(box.w - 4) < 1e-9 && Math.abs(box.h - 10) < 1e-9, 'rotation preserves the body');
  // A jointed part keeps its local points; only placement changes.
  assert.deepEqual(transform(polygon(0, 0, square), 7, 3).points, square);
});

test('convexity is checked rather than trusted, because SAT separates a concave body wrongly', () => {
  assert.equal(convex(square), true);
  assert.equal(convex([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), true);
  assert.equal(convex([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), false, 'an arrowhead is concave');
  assert.equal(convex([{ x: 0, y: 0 }, { x: 10, y: 0 }]), false, 'two points are not a body');
  assert.equal(convex([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]), false, 'a straight line has no interior');
});

// The payoff of one description: a shape the generator has never emitted before is already solid to
// movement, to shots and to sight, with no new branch in any of the three.
test('a polygon obstacle blocks occupancy, movement and sight like any other geometry', () => {
  const wall = { id: 'poly', kind: 'ruin-wall', x: 12000, y: 6000, w: 0, h: 0, points: square };
  const map = { width: 24000, height: 12000, obstacles: [wall], gates: [] };
  assert.equal(canOccupy(map, 12000, 6000), false, 'inside a polygon is not occupiable');
  assert.equal(canOccupy(map, 12000, 6100), true, 'clear ground beside it is');
  assert.equal(lineClear(map, { x: 11900, y: 6000 }, { x: 12100, y: 6000 }), false, 'it blocks sight');
  assert.equal(lineClear(map, { x: 11900, y: 6200 }, { x: 12100, y: 6200 }), true, 'and only where it stands');

  const runner = { role: 'contestant', x: 11940, y: 6000, boost: 0, stun: 0 };
  for (let tick = 0; tick < 12; tick++) movePlayer(map, runner, { x: 1, y: 0 });
  assert.ok(runner.x < 11970, `a runner is stopped by the polygon face: ${runner.x}`);
  assert.equal(canOccupy(map, runner.x, runner.y), true, 'and is never pushed inside it');
});

test('the SAT body for each form is the one that form needs', () => {
  assert.equal(body(circle(0, 0, 5)).r, 5);
  assert.equal(body(rect(1, 2, 3, 4)).pos.x, 1);
  assert.equal(body(polygon(9, 9, square)).pos.y, 9);
});
