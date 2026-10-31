import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, polygon, rect } from '../shared/shape.ts';
import { createRegionMask, createRegionRouteSearch, travelClear } from '../map/micro/geometry.ts';
import { createRouteClearance } from '../map/micro/route-clearance.ts';

const p = (x, y) => ({ x, y });
const grid = (width = 16, height = 12, omit = () => false) => createRegionMask({ cellSize: 10,
  cells: Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width) }))
    .filter(c => !omit(c.x, c.y)) });

function compareRoutes(mask, blockers, start, targets, radius, cached = createRouteClearance(mask, blockers, radius).accepted()) {
  const route = createRegionRouteSearch(mask, blockers, start, radius, cached);
  const ordinary = createRegionRouteSearch(mask, blockers, start, radius);
  for (const target of targets) assert.deepEqual(route(target), ordinary(target), `route to ${target.x},${target.y}`);
}

test('clearance revisions match travelClear and preserve exact routes as swept blockers accumulate', () => {
  const mask = grid(16, 12, (x, y) => x >= 6 && x <= 8 && y >= 4 && y <= 7);
  const start = p(15, 55), targets = [p(135, 55), p(35, 25), p(115, 95), p(15, 55), p(65, 55)];
  const initial = [rect(50, 0, 10, 45)];
  const clearance = createRouteClearance(mask, initial, 2);
  let blockers = structuredClone(initial);
  const pairs = [[start, targets[0]], [start, targets[1]], [p(35, 55), p(115, 55)], [p(25, 25), p(35, 25)]];
  const stages = [
    [circle(95, 75, 8)],
    [polygon(0, 0, [p(80, 25), p(91, 22), p(89, 36), p(79, 34)])],
    [rect(75, 45, 3, 20)],
  ];
  for (const added of stages) {
    const prepared = clearance.prepare(added);
    for (const [a, b] of pairs) assert.equal(prepared.clear(a, b), travelClear(mask, [...blockers, ...added], a, b, 2));
    prepared.commit();
    blockers.push(...structuredClone(added));
    const accepted = clearance.accepted();
    for (const [a, b] of pairs) assert.equal(accepted(a, b), travelClear(mask, blockers, a, b, 2));
    // Compare routes through a fresh search backed by the same growing cache. This
    // exercises retained clear prefixes when each blocker revision is committed.
    compareRoutes(mask, blockers, start, targets, 2, accepted);
  }
});

test('direct and near/distant checks use swept clearance, and cache instances keep radii and geometry separate', () => {
  const mask = grid(), a = p(15, 55), b = p(125, 55);
  const wall = rect(68, 48, 2, 14); // Both endpoints are free; the thin wall intersects the swept segment.
  for (const radius of [1, 4]) {
    const one = createRouteClearance(mask, [], radius), two = createRouteClearance(mask, [wall], radius);
    const near = p(25, 55), distant = p(125, 55);
    assert.equal(one.accepted()(a, near), travelClear(mask, [], a, near, radius));
    assert.equal(two.accepted()(a, distant), travelClear(mask, [wall], a, distant, radius));
    assert.notEqual(one.accepted()(a, distant), two.accepted()(a, distant));
    compareRoutes(mask, [wall], a, [near, distant], radius);
  }
});

test('door-policy and mask identities keep clearance instances independent', () => {
  const cells = Array.from({ length: 16 * 12 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16) }));
  const accessMask = createRegionMask({ cellSize: 10, cells });
  const fillMask = createRegionMask({ cellSize: 10, cells: structuredClone(cells) });
  const a = p(15, 55), b = p(125, 55), door = rect(68, 48, 2, 14);
  // These separate factories model the same geometry under different door policies.
  const withDoors = createRouteClearance(accessMask, [door], 2);
  const withoutDoors = createRouteClearance(accessMask, [], 2);
  const otherMask = createRouteClearance(fillMask, [], 2);
  assert.equal(withDoors.accepted()(a, b), false);
  assert.equal(withoutDoors.accepted()(a, b), true);
  assert.equal(otherMask.accepted()(a, b), true);
  assert.equal(withoutDoors.accepted()(a, b), travelClear(fillMask, [], a, b, 2));
});

test('uncommitted rejected and stale trials cannot publish; commits are single-use and views are revision-bound', () => {
  const mask = grid(), a = p(55, 55), b = p(60, 55), initial = [rect(500, 500, 1, 1)];
  const cache = createRouteClearance(mask, initial, 2), before = cache.accepted();
  assert.equal(before(a, b), true);
  const rejected = cache.prepare([rect(58, 48, 2, 14)]);
  assert.equal(rejected.clear(a, b), false);
  assert.equal(cache.accepted()(a, b), true, 'uncommitted trial did not affect accepted state');
  const first = cache.prepare([circle(300, 300, 5)]), competing = cache.prepare([rect(200, 200, 5, 5)]);
  assert.equal(first.clear(a, b), true);
  first.commit();
  assert.throws(() => before(a, b), /stale route clearance trial/i);
  assert.throws(() => first.commit(), /stale route clearance trial/i);
  assert.throws(() => competing.clear(a, b), /stale route clearance trial/i);
  assert.throws(() => competing.commit(), /stale route clearance trial/i);
  const current = cache.accepted();
  assert.equal(current(a, b), true);
  const blocked = cache.prepare([rect(58, 48, 2, 14)]);
  blocked.commit();
  assert.equal(cache.accepted()(a, b), false);
});

test('initial and prepared collider geometry is copied at factory and prepare boundaries', () => {
  const mask = grid(), a = p(15, 55), b = p(125, 55);
  const original = rect(500, 500, 5, 5), cache = createRouteClearance(mask, [original], 2);
  original.x = 68; original.y = 48; original.w = 2; original.h = 14;
  assert.equal(cache.accepted()(a, b), true, 'mutating initial caller shape cannot change the cache');
  const added = [circle(300, 300, 4)], prepared = cache.prepare(added);
  added[0].x = 68; added[0].y = 55; added[0].r = 8;
  assert.equal(prepared.clear(a, b), true, 'mutating added caller shape cannot change the prepared trial');
  prepared.commit();
  assert.equal(cache.accepted()(a, b), true);
});

test('polygon point aliases are copied at factory and prepare boundaries', () => {
  const mask = grid(), a = p(15, 55), b = p(125, 55);
  const initial = polygon(0, 0, [p(300, 300), p(310, 300), p(310, 310), p(300, 310)]);
  const cache = createRouteClearance(mask, [initial], 2);
  initial.points[0].x = 68; initial.points[0].y = 48;
  initial.points[1].x = 70; initial.points[1].y = 48;
  initial.points[2].x = 70; initial.points[2].y = 62;
  initial.points[3].x = 68; initial.points[3].y = 62;
  assert.equal(cache.accepted()(a, b), true, 'mutating initial polygon points cannot change cached geometry');

  const added = polygon(0, 0, [p(300, 300), p(310, 300), p(310, 310), p(300, 310)]);
  const prepared = cache.prepare([added]);
  added.points.forEach((point, i) => Object.assign(point, [p(68, 48), p(70, 48), p(70, 62), p(68, 62)][i]));
  assert.equal(prepared.clear(a, b), true, 'mutating prepared polygon points cannot alter trial geometry');
  prepared.commit();
  assert.equal(cache.accepted()(a, b), true);
});

test('grid-node and cardinal-edge cache reuses clearances and locally rechecks added blockers', () => {
  const base = grid(), calls = new Map();
  const mask = { ...base, contains(shape) {
    const key = JSON.stringify(shape); calls.set(key, (calls.get(key) ?? 0) + 1);
    return base.contains(shape);
  } };
  const cache = createRouteClearance(mask, [], 2), center = p(55, 55);
  const edges = [[center, p(60, 55)], [center, p(55, 60)], [center, p(50, 55)], [center, p(55, 50)]];
  const remote = p(15, 25);
  const totalCalls = () => [...calls.values()].reduce((sum, count) => sum + count, 0);
  const accepted = cache.accepted();
  assert.equal(accepted(center, center), true, 'grid node is clear');
  for (const [a, b] of edges) assert.equal(accepted(a, b), true, 'each cardinal direction is clear');
  const afterFirst = totalCalls();
  assert.ok(afterFirst > 0);
  assert.equal(accepted(center, center), true);
  for (const [a, b] of edges) assert.equal(accepted(a, b), true);
  assert.equal(totalCalls(), afterFirst, 'cached nodes and all directed cardinal edges skip mask work');
  assert.equal(accepted(remote, remote), true);

  // This blocker lies inside each cardinal sweep near the shared node.
  const added = [rect(54, 54, 2, 2)];
  const prepared = cache.prepare(added);
  for (const [a, b] of edges) {
    assert.equal(prepared.clear(a, b), travelClear(mask, added, a, b, 2), 'prepared cardinal check matches exact clearance');
    assert.equal(prepared.clear(a, b), travelClear(mask, added, a, b, 2), 'pending result is reused in the trial');
  }
  const afterPrepared = totalCalls();
  assert.ok(afterPrepared > afterFirst, 'locally affected cached edges are recomputed against the mask');
  prepared.commit();
  const afterCommit = totalCalls();
  const current = cache.accepted();
  for (const [a, b] of edges) assert.equal(current(a, b), false, 'committed local blocker blocks each direction');
  assert.equal(totalCalls(), afterCommit, 'committed blocked results are already exact');
  assert.equal(current(remote, remote), true);
  assert.equal(totalCalls(), afterCommit, 'remote cached node remains reused');
});

test('edge cache avoids row wrapping and off-grid connectors match exact clearance', () => {
  const base = grid(), calls = new Map();
  const mask = { ...base, contains(shape) {
    const key = JSON.stringify(shape); calls.set(key, (calls.get(key) ?? 0) + 1);
    return base.contains(shape);
  } };
  const cache = createRouteClearance(mask, [], 1), accepted = cache.accepted();
  const totalCalls = () => [...calls.values()].reduce((sum, count) => sum + count, 0);

  // Adjacent linear node indices at a row boundary are far apart in space and
  // must not alias either of the nearby real horizontal edges.
  const lastEdge = [p(155, 0), p(160, 0)];
  const nextRowEdge = [p(0, 5), p(5, 5)];
  for (const [a, b] of [lastEdge, nextRowEdge]) {
    assert.equal(accepted(a, b), travelClear(mask, [], a, b, 1));
  }
  const afterEdges = totalCalls();
  assert.equal(accepted(p(160, 0), p(0, 5)), travelClear(mask, [], p(160, 0), p(0, 5), 1));
  const afterConnector = totalCalls();
  assert.ok(afterConnector > afterEdges, 'non-cardinal row-boundary connector uses exact fallback');
  assert.equal(accepted(p(160, 0), p(0, 5)), travelClear(mask, [], p(160, 0), p(0, 5), 1));
  assert.ok(totalCalls() > afterConnector, 'arbitrary connectors are not memoized');

  const offGrid = [p(12, 13), p(83, 47)];
  assert.equal(accepted(...offGrid), travelClear(mask, [], ...offGrid, 1));
});

test('a new thin barrier invalidates a cached edge whose cached endpoint bodies stay clear', () => {
  const mask = grid(), a = p(55, 55), b = p(60, 55), cache = createRouteClearance(mask, [], 1);
  const clear = cache.accepted();
  assert.equal(clear(a, a), true);
  assert.equal(clear(b, b), true);
  assert.equal(clear(a, b), true);
  assert.equal(clear(b, a), true);
  const trial = cache.prepare([rect(57.4, 54, 0.2, 2)]);
  assert.equal(trial.clear(a, a), true);
  assert.equal(trial.clear(b, b), true);
  assert.equal(trial.clear(a, b), false);
  assert.equal(trial.clear(b, a), false);
  trial.commit();
  assert.equal(cache.accepted()(a, b), false);
});

test('translated and negative-origin masks invalidate warmed edges even when a trial never queries them', () => {
  for (const [dx, dy] of [[-40, -25], [200, -300]]) {
    const mask = createRegionMask({ cellSize: 10, cells: grid().cells.map(c => ({ x: c.x + dx, y: c.y + dy })) });
    const shift = (x, y) => p(dx * 10 + x, dy * 10 + y);
    const a = shift(55, 55), b = shift(60, 55), remote = shift(15, 25);
    const cache = createRouteClearance(mask, [], 1), clear = cache.accepted();
    assert.equal(clear(a, b), true);
    assert.equal(clear(b, a), true);
    assert.equal(clear(remote, remote), true);
    const added = [rect(dx * 10 + 57.4, dy * 10 + 54, 0.2, 2)];
    cache.prepare(added).commit();
    const current = cache.accepted();
    for (const [from, to] of [[a, b], [b, a], [a, a], [b, b], [remote, remote]]) {
      assert.equal(current(from, to), travelClear(mask, added, from, to, 1));
    }
    assert.equal(current(a, b), false);
  }
});
