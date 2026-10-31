import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhysicsGeometry, physicsGate, MAX_PHYSICS_EXTENT } from '../shared/simulation/physics-geometry.ts';
import { insideMap } from '../shared/movement.ts';

const empty = (more = {}) => ({ width: 250, height: 250, obstacles: [], gates: [], ...more });

function contains(body, x, y) {
  const dx = x - body.x, dy = y - body.y;
  if (body.shape.kind === 'box') return Math.abs(dx) <= body.shape.hx && Math.abs(dy) <= body.shape.hy;
  if (body.shape.kind === 'circle') return Math.hypot(dx, dy) < body.shape.radius;
  const points = body.shape.vertices;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = (b.x - a.x) * (dy - a.y) - (b.y - a.y) * (dx - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

test('obstacle shapes preserve their stored anchors and gate footprint', () => {
  const map = empty({ obstacles: [
    { id: 'circle', x: 65, y: 55, w: 30, h: 30, r: 15 },
    { id: 'rect', x: 20, y: 35, w: 30, h: 10 },
    { id: 'poly', x: 80, y: 95, w: 20, h: 20,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }] },
  ] });
  const bodies = buildPhysicsGeometry(map);
  assert.deepEqual(bodies.slice(0, 2), [
    { id: 'obstacle:circle', kind: 'static', x: 65, y: 55, shape: { kind: 'circle', radius: 15 } },
    { id: 'obstacle:rect', kind: 'static', x: 35, y: 40, shape: { kind: 'box', hx: 15, hy: 5 } },
  ]);
  const poly = bodies[2];
  assert.equal(poly.id, 'obstacle:poly');
  assert.equal(poly.x, 90);
  assert.ok(Math.abs(poly.y - (95 + 20 / 3)) < 1e-12);
  assert.deepEqual(poly.shape.vertices.map(p => ({ x: p.x + poly.x, y: p.y + poly.y })),
    [{ x: 80, y: 95 }, { x: 100, y: 95 }, { x: 90, y: 115 }]);
  assert.equal(bodies.some(body => body.id.startsWith('gate:')), false);
  assert.deepEqual(physicsGate({ id: 'g', x: 100, y: 110, w: 0, h: 0 }),
    { id: 'gate:g', kind: 'static', x: 100, y: 110, shape: { kind: 'box', hx: 13, hy: 27 } });
});

test('mask void boxes merge row runs and represent holes, corners and outer faces', () => {
  const map = empty({ width: 250, height: 200, playableArea: { cellSize: 50, rows: [
    { y: 0, runs: [[0, 5]] }, { y: 1, runs: [[0, 5]] },
    { y: 2, runs: [[0, 2], [3, 5]] }, { y: 3, runs: [[0, 2], [3, 4]] },
  ] } });
  const bodies = buildPhysicsGeometry(map);
  const voids = bodies.filter(body => body.id.startsWith('void:'));
  assert.equal(voids.length, 2);
  assert.ok(voids.some(body => body.x === 125 && body.y === 150 && body.shape.hx === 25 && body.shape.hy === 50));
  for (const [x, y] of [[125, 125], [125, 175], [225, 175], [0, 100], [250, 100], [100, -1]]) {
    assert.ok(bodies.some(body => contains(body, x, y)), `${x},${y} has static contact`);
  }
  for (const [x, y] of [[75, 75], [75, 125], [175, 125]]) {
    assert.equal(insideMap(map, x, y), true);
    assert.equal(bodies.some(body => contains(body, x, y)), false, `${x},${y} stays playable`);
  }
});

test('legacy diamond has diagonal contact faces at the same boundary as insideMap', () => {
  const map = empty();
  const bodies = buildPhysicsGeometry(map);
  assert.equal(bodies.filter(body => body.id.startsWith('boundary:diamond:')).length, 4);
  for (const [x, y] of [[25, 25], [225, 25], [225, 225], [25, 225], [125, 39], [39, 125]]) {
    assert.equal(insideMap(map, x, y), false);
    assert.ok(bodies.some(body => contains(body, x, y)), `${x},${y} excluded`);
  }
  for (const [x, y] of [[125, 41], [41, 125], [125, 125], [209, 125], [125, 209]]) {
    assert.equal(insideMap(map, x, y), true);
    assert.equal(bodies.some(body => contains(body, x, y)), false, `${x},${y} playable`);
  }
});

test('malformed static geometry is refused before the engine sees it', () => {
  assert.throws(() => buildPhysicsGeometry(empty({ width: Infinity })), /extent/);
  assert.throws(() => buildPhysicsGeometry(empty({ width: MAX_PHYSICS_EXTENT + 1 })), /extent/);
  assert.throws(() => buildPhysicsGeometry(empty({ height: MAX_PHYSICS_EXTENT + 1 })), /extent/);
  assert.throws(() => buildPhysicsGeometry(empty({ obstacles: [{ id: 'bad', x: 0, y: 0, w: 0, h: 1 }] })), /box/);
  assert.throws(() => buildPhysicsGeometry(empty({ obstacles: [{ id: 'bad', x: 0, y: 0, w: 1, h: 1, r: NaN }] })), /obstacle/);
  assert.throws(() => buildPhysicsGeometry(empty({ obstacles: [{ id: 'bad', x: 0, y: 0, w: 1, h: 1,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }] })), /polygon/);
  assert.throws(() => buildPhysicsGeometry(empty({ playableArea: { cellSize: 0.001, rows: [] } })), /capacity/);
  assert.throws(() => buildPhysicsGeometry(empty({ playableArea: { cellSize: 50, rows: [{ y: 0, runs: [[0, 3], [2, 5]] }] } })), /run/);
});
