import test from 'node:test';
import assert from 'node:assert';
import { vendorModule } from '../server/vendor-modules.js';

// Each wrapped package must load as an ES module and work through its exported API.
const load = async (name) => (await import(`data:text/javascript,${encodeURIComponent(vendorModule(name))}`)).default;

test('vendorModule sat loads as an ES module that detects collisions', async () => {
  const SAT = await load('sat');
  const circle = (x) => new SAT.Circle(new SAT.Vector(x, 0), 2);
  const response = new SAT.Response();
  assert.equal(SAT.testCircleCircle(circle(0), circle(3), response), true);
  assert.equal(response.overlap, 1);
  assert.equal(SAT.testCircleCircle(circle(0), circle(5)), false);
  const box = new SAT.Box(new SAT.Vector(0, 0), 4, 4).toPolygon();
  assert.equal(SAT.testPolygonCircle(box, circle(5)), true);
  assert.equal(SAT.testPolygonCircle(box, circle(7)), false);
});

test('vendorModule pathfinding loads as an ES module that routes around walls', async () => {
  const PF = await load('pathfinding');
  const grid = new PF.Grid([[0, 1, 0], [0, 0, 0]]);
  assert.deepEqual(new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true }).findPath(0, 0, 2, 0, grid),
    [[0, 0], [0, 1], [1, 1], [2, 1], [2, 0]]);
  assert.deepEqual(new PF.AStarFinder().findPath(0, 0, 2, 0, new PF.Grid([[0, 1, 0], [0, 1, 0]])), []);
});
