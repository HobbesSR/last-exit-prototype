import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, polygon, rect } from '../shared/shape.ts';
import { createRegionMask, createRegionRouteSearch, findRegionRoute, findRegionRoutes, routeStarts, travelClear } from '../map/micro/geometry.ts';

// Independent pre-batch algorithm: comparing only against the single-target wrapper would
// allow both public APIs to acquire the same changed connector or predecessor ordering.
function independentRoute(mask, blockers, a, b, radius) {
  if (travelClear(mask, blockers, a, b, radius)) return [a, b];
  const step = mask.cellSize / 2, box = mask.bounds;
  const width = Math.round(box.w / step) + 1, height = Math.round(box.h / step) + 1;
  const point = i => ({ x: box.x + i % width * step, y: box.y + Math.floor(i / width) * step });
  const walkable = new Map();
  const free = i => {
    if (!walkable.has(i)) { const p = point(i); walkable.set(i, travelClear(mask, blockers, p, p, radius)); }
    return walkable.get(i);
  };
  const queue = [], previous = new Map();
  for (const i of routeStarts(step, box, width, height, a)) if (free(i) && travelClear(mask, blockers, a, point(i), radius)) { queue.push(i); previous.set(i, -1); }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], p = point(i);
    if (Math.hypot(p.x - b.x, p.y - b.y) <= step * 3 && travelClear(mask, blockers, p, b, radius)) {
      const path = [b]; let cursor = i;
      while (cursor !== -1) { path.push(point(cursor)); cursor = previous.get(cursor); }
      path.push(a); path.reverse();
      return path.filter((p, j) => !j || j === path.length - 1 || Math.abs((p.x - path[j - 1].x) * (path[j + 1].y - p.y) - (p.y - path[j - 1].y) * (path[j + 1].x - p.x)) > 1e-7);
    }
    const x = i % width, y = Math.floor(i / width);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
      const next = i + dx + dy * width;
      if (previous.has(next) || !free(next) || !travelClear(mask, blockers, p, point(next), radius)) continue;
      previous.set(next, i); queue.push(next);
    }
  }
  return null;
}

const point = (x, y) => ({ x, y });
const maskOf = (...boxes) => createRegionMask({ cellSize: 10, cells: boxes.flatMap(([x, y, w, h]) =>
  Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }))) });

function compare(mask, blockers, a, targets, radius) {
  const expected = targets.map(b => independentRoute(mask, blockers, a, b, radius));
  assert.deepEqual(findRegionRoutes(mask, blockers, a, targets, radius), expected);
  assert.deepEqual(targets.map(b => findRegionRoute(mask, blockers, a, b, radius)), expected);
  const orders = [targets.map((_, i) => i).reverse(), targets.map((_, i) => (i + 2) % targets.length)];
  for (const order of orders) {
    const route = createRegionRouteSearch(mask, blockers, a, radius);
    for (const i of order) assert.deepEqual(route(targets[i]), expected[i], `target ${i} after ${order}`);
  }
  for (let i = 0; i < expected.length; i++) if (expected[i]) {
    const path = expected[i];
    for (let j = 1; j < path.length; j++) assert.ok(travelClear(mask, blockers, path[j - 1], path[j], radius));
  }
  return expected;
}

test('batch paths retain independent BFS connectors around obstacles, including duplicates and off-grid targets', () => {
  const mask = maskOf([-2, -2, 16, 12]);
  const blockers = [rect(40, -20, 10, 70), circle(85, 55, 8), polygon(0, 0, [point(60, 70), point(75, 65), point(80, 85)])];
  const targets = [point(65, 20), point(115.3, 10.7), point(95, 80), point(10.3, 65.7), point(65, 20), point(45, 20), point(200, 200)];
  for (const radius of [1, 4]) {
    const paths = compare(mask, blockers, point(5.3, 10.7), targets, radius);
    assert.ok(paths[0]?.length > 2, 'obstructed target uses grid detour');
    assert.equal(paths[3]?.length, 2, 'direct target stays direct');
    assert.equal(paths[5], null, 'blocked endpoint');
    assert.equal(paths[6], null, 'outside endpoint');
  }
});

test('an exhausted disconnected search still allows earlier connectors and direct paths for later targets', () => {
  const mask = maskOf([0, 0, 8, 8], [10, 0, 3, 3]);
  const blockers = [rect(30, 0, 10, 55)];
  const paths = compare(mask, blockers, point(10, 10), [point(115, 15), point(60, 10), point(10, 65), point(60, 10)], 2);
  assert.equal(paths[0], null);
  assert.ok(paths[1]?.length > 2);
  assert.equal(paths[2]?.length, 2);
});

test('a later target expands the node where the earlier target stopped before expansion', () => {
  // Radius 3 leaves just one sample line down each one-cell-wide arm. Reaching the far
  // target must expand the near target's stopping node; no parallel grid line can bypass it.
  const mask = maskOf([0, 0, 8, 1], [7, 1, 1, 7]);
  const paths = compare(mask, [], point(5, 5), [point(75, 35), point(75, 75)], 3);
  assert.ok(paths.every(path => path?.length > 2));
});

test('lazy shared searches avoid repeated grid expansion and never build a grid for direct-only targets', () => {
  const base = maskOf([0, 0, 12, 10]), blockers = [rect(40, 0, 10, 65)], a = point(10, 10);
  let checks = 0;
  const mask = { ...base, contains(shape) { checks++; return base.contains(shape); } };
  const route = createRegionRouteSearch(mask, blockers, a, 2);
  assert.equal(checks, 0, 'factory is lazy');
  assert.deepEqual(route(point(10, 50)), [a, point(10, 50)]);
  assert.equal(checks, 3, 'only the direct capsule was checked');
  checks = 0;
  const targets = [point(100, 10), point(90, 20), point(80, 30)];
  const shared = findRegionRoutes(mask, blockers, a, targets, 2), sharedChecks = checks;
  checks = 0;
  assert.deepEqual(targets.map(b => findRegionRoute(mask, blockers, a, b, 2)), shared);
  assert.ok(sharedChecks < checks, `shared ${sharedChecks} < independent ${checks}`);
  assert.deepEqual(findRegionRoutes(mask, blockers, a, [], 2), []);
});
