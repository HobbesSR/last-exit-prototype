import test from 'node:test';
import assert from 'node:assert/strict';
import { rect } from '../shared/shape.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapCollision } from '../map/micro/adapter.ts';
import { mapFreeSpace } from '../shared/free-space.ts';
import { navigationMap } from '../shared/map/navigation.ts';
import { sweptClear } from '../shared/movement.ts';
import { classifyNavigationRoute } from '../map/tools/navigation-structure.ts';
import { measureFixedRoutes } from '../tools/experiments/barrier-routes.mjs';

function syntheticMap(elements = []) {
  const cells = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6) }));
  return { layout: { seed: 'static-barrier' }, results: [{ version: 'region-2',
    brief: { id: 'room', seed: 'static-barrier', type: 'open', cellSize: 48, cells, zones: [], portals: [] },
    elements, loot: [], coreElements: [] }] };
}

const pair = (from = { x: 48, y: 144 }, to = { x: 240, y: 144 }) => ({
  contestant: [{ category: 'fixed-crossing', from, to }],
  hunter: [{ category: 'fixed-crossing', from, to }],
});
const routeFor = (result, body) => result.roles.find(role => role.body === body).samples[0];

test('fixed endpoints use whole-map geometry and return a straight route witness', () => {
  const result = measureFixedRoutes(syntheticMap(), pair());
  for (const body of ['contestant', 'hunter']) {
    const route = routeFor(result, body);
    assert.equal(route.status, 'complete');
    assert.equal(route.ratio, 1);
    assert.deepEqual(route.from, { x: 48, y: 144 });
    assert.deepEqual(route.to, { x: 240, y: 144 });
    assert.ok(route.points.length >= 2);
  }
});

test('a partial wall produces a swept-audited detour for both bodies', () => {
  const wall = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(136, 60, 16, 168) }] } };
  const result = measureFixedRoutes(syntheticMap([wall]), pair());
  for (const body of ['contestant', 'hunter']) {
    const route = routeFor(result, body);
    assert.equal(route.status, 'complete');
    assert.ok(route.ratio > 1.2, `${body} ratio ${route.ratio}`);
    assert.ok(route.points.some(p => p.y < 100 || p.y > 188), 'route should pass around a wall end');
  }
});

test('blocked endpoints remain invalid and are never replaced by nearby points', () => {
  const block = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(30, 120, 36, 48) }] } };
  const result = measureFixedRoutes(syntheticMap([block]), pair());
  for (const body of ['contestant', 'hunter']) {
    const route = routeFor(result, body);
    assert.equal(route.status, 'invalid-endpoint');
    assert.deepEqual(route.from, { x: 48, y: 144 });
    assert.equal(route.length, null);
    assert.deepEqual(route.points, []);
  }
});

test('disconnected valid endpoints are unreachable, with zero-distance pairs omitted', () => {
  const wall = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(136, 0, 16, 288) }] } };
  const result = measureFixedRoutes(syntheticMap([wall]), pair());
  for (const body of ['contestant', 'hunter']) {
    const route = routeFor(result, body);
    assert.equal(route.status, 'unreachable');
    assert.equal(route.length, null);
    assert.equal(route.ratio, null);
  }
  assert.equal(measureFixedRoutes(syntheticMap(), pair({ x: 100, y: 100 }, { x: 100, y: 100 })).roles
    .every(role => role.samples.length === 0), true);
});

test('zero-distance pairs do not shift later stratum labels', () => {
  const pairs = [
    { category: 'fixed-crossing', stratum: 'first', from: { x: 48, y: 144 }, to: { x: 100, y: 144 } },
    { category: 'fixed-crossing', stratum: 'skipped', from: { x: 100, y: 144 }, to: { x: 100, y: 144 } },
    { category: 'fixed-crossing', stratum: 'last', from: { x: 100, y: 144 }, to: { x: 240, y: 144 } },
    { category: 'fixed-crossing', from: { x: 48, y: 144 }, to: { x: 240, y: 144 } },
  ];
  const result = measureFixedRoutes(syntheticMap(), { contestant: pairs, hunter: pairs });
  for (const role of result.roles) assert.deepEqual(role.samples.map(sample => sample.stratum), ['first', 'last', 'focused']);
});

function classifierFixture(elements = []) {
  const nav = navigationMap(builtMapCollision(composeRegions(syntheticMap(elements).results)), true);
  const clearance = 15, radius = 5;
  const space = mapFreeSpace(nav, 'classifier test', [{ x: 0, y: 0, w: nav.width, h: nav.height }], clearance);
  return { nav, space, clearance, radius };
}

test('a missing path between endpoints in one component is a search miss', () => {
  const { nav, space, clearance, radius } = classifierFixture();
  assert.equal(classifyNavigationRoute(nav, space, { x: 48, y: 144 }, { x: 240, y: 144 }, null, clearance, radius), 'search-miss');
});

test('the classifier rejects a witness that crosses a thin wall', () => {
  const wall = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(140, 100, 4, 80) }] } };
  const { nav, space, clearance, radius } = classifierFixture([wall]);
  const from = { x: 48, y: 144 }, to = { x: 240, y: 144 };
  assert.ok(sweptClear(nav, from, from, radius) && sweptClear(nav, to, to, radius));
  const path = { points: [from, to], length: 192, leads: [false, false] };
  assert.equal(classifyNavigationRoute(nav, space, from, to, path, clearance, radius), 'sweep-defect');
});

test('flagged endpoint leads use body radius instead of navigation clearance', () => {
  const wall = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(120, 120, 40, 10) }] } };
  const { nav, space, clearance, radius } = classifierFixture([wall]);
  const from = { x: 90, y: 141 }, to = { x: 190, y: 141 };
  assert.equal(sweptClear(nav, from, to, radius), true);
  assert.equal(sweptClear(nav, from, to, clearance), false);
  for (const leads of [[true, false], [false, true]]) {
    assert.equal(classifyNavigationRoute(nav, space, from, to, { points: [from, to], length: 100, leads }, clearance, radius), 'complete');
  }
  assert.equal(classifyNavigationRoute(nav, space, from, to,
    { points: [from, to], length: 100, leads: [false, false] }, clearance, radius), 'sweep-defect');
});
