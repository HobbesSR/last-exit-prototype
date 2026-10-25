import test from 'node:test';
import assert from 'node:assert';
import { vendorModule } from '../server/vendor-modules.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

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

test('dev geometry vendors clip polygons and constrain a triangulation without browser globals', async () => {
  const Clipper = await load('clipper-lib');
  const square = (x, y, size) => [{ X: x, Y: y }, { X: x + size, Y: y },
    { X: x + size, Y: y + size }, { X: x, Y: y + size }];
  const clipper = new Clipper.Clipper(), result = [];
  clipper.AddPath(square(0, 0, 10), Clipper.PolyType.ptSubject, true);
  clipper.AddPath(square(5, 5, 10), Clipper.PolyType.ptClip, true);
  assert.equal(clipper.Execute(Clipper.ClipType.ctIntersection, result), true);
  assert.equal(result.length, 1);
  assert.equal(Math.abs(Clipper.Clipper.Area(result[0])), 25);

  const Delaunator = await load('delaunator');
  const Constrainautor = await load('@kninnug/constrainautor');
  const triangulation = Delaunator.from([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(triangulation.triangles.length, 6);
  const constraints = new Constrainautor(triangulation);
  constraints.constrainOne(0, 2);
  const edge = [...triangulation.triangles].findIndex((start, index, triangles) =>
    start === 0 && triangles[index % 3 === 2 ? index - 2 : index + 1] === 2);
  assert.ok(edge >= 0, 'requested diagonal exists after constraining');
  assert.ok(constraints.isConstrained(edge));
});

test('dev module serving resolves geometry imports through registered vendors and gates their URLs', async () => {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'vendor-modules-'));
  try {
    for (const devTools of ['all', 'none']) {
      const server = await createArenaServer({ devTools, replayDir, profileSummary: false });
      try {
        const base = await listen(server);
        const source = await (await fetch(`${base}/shared/shape-construction.ts`)).text();
        for (const [name, url] of [['clipper-lib', '/vendor/clipper.mjs'], ['delaunator', '/vendor/delaunator.mjs'],
          ['@kninnug/constrainautor', '/vendor/constrainautor.mjs']]) {
          assert.ok(source.includes(`from '${devTools === 'all' ? url : name}'`));
          const response = await fetch(`${base}${url}`);
          assert.equal(response.status, devTools === 'all' ? 200 : 404, url);
          if (devTools === 'all') {
            assert.match(response.headers.get('content-type'), /javascript/);
            const exported = (await import(`data:text/javascript,${encodeURIComponent(await response.text())}`)).default;
            assert.ok(exported, name);
          }
        }
      } finally { await server.close(); }
    }
  } finally { await rm(replayDir, { recursive: true, force: true }); }
});
