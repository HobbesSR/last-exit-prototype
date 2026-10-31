import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, polygon, rect } from '../shared/shape.ts';
import { createRegionMask, createRegionRouteSearch, travelClear } from '../map/micro/geometry.ts';
import { createRouteClearance } from '../map/micro/route-clearance.ts';

const p = (x, y) => ({ x, y });
const grid = (width = 16, height = 12, omit = () => false) => createRegionMask({ cellSize: 10,
  cells: Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width) }))
    .filter(c => !omit(c.x, c.y)) });

function compareRoutes(mask, blockers, start, targets, radius) {
  const cached = createRouteClearance(mask, blockers, radius).accepted();
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
    compareRoutes(mask, blockers, start, targets, 2);
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

test('uncommitted rejected and stale trials cannot publish; commits are single-use and views are revision-bound', () => {
  const mask = grid(), a = p(15, 55), b = p(125, 55), initial = [rect(500, 500, 1, 1)];
  const cache = createRouteClearance(mask, initial, 2), before = cache.accepted();
  assert.equal(before(a, b), true);
  const rejected = cache.prepare([rect(68, 48, 2, 14)]);
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
  const blocked = cache.prepare([rect(68, 48, 2, 14)]);
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

test('accepted repeated checks reuse mask containment and new blockers invalidate only affected clear results', () => {
  const base = grid(), calls = new Map();
  const mask = { ...base, contains(shape) {
    const key = JSON.stringify(shape); calls.set(key, (calls.get(key) ?? 0) + 1);
    return base.contains(shape);
  } };
  const cache = createRouteClearance(mask, [], 2), a = p(15, 55), affected = p(55, 55), remote = p(15, 25);
  const accepted = cache.accepted();
  assert.equal(accepted(a, affected), true);
  const afterFirst = calls.size;
  assert.ok(afterFirst > 0);
  assert.equal(accepted(a, affected), true);
  assert.equal(calls.size, afterFirst, 'accepted result is reused');
  assert.equal(accepted(a, remote), true);
  const afterRemoteFirst = calls.size;
  const added = [rect(34, 50, 2, 10)];
  const prepared = cache.prepare(added);
  assert.equal(prepared.clear(a, affected), false, 'added geometry overlaps the formerly clear swept route');
  prepared.commit();
  const afterCommit = calls.size;
  assert.equal(cache.accepted()(a, affected), false);
  assert.equal(calls.size, afterCommit, 'affected prior clearance is retested against geometry without rescanning the immutable mask');
  assert.equal(cache.accepted()(a, remote), true);
  assert.equal(calls.size, afterRemoteFirst, 'remote addition preserves the prior mask work');
});
