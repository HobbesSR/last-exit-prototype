import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeGraph, beginQuery, queryGraph } from '../tools/navigation/graph.mjs';
import { createHierarchy } from '../tools/navigation/hierarchy.mjs';

const map = (width, height, obstacles = []) => ({
  width, height, obstacles, gates: [], buildings: [],
  playableArea: { cellSize: 6, rows: Array.from({ length: height / 6 }, (_, y) => ({ y, runs: [[0, width / 6]] })) },
});

test('off-grid thin wall blocks sampled links and endpoint connectors', () => {
  const graph = bakeGraph(map(96, 96, [{ id: 'wall', kind: 'building', x: 49, y: 0, w: 2, h: 96 }]), { radius: 2 });
  const result = queryGraph(graph, { x: 35, y: 30 }, { x: 65, y: 30 });
  assert.equal(result.status, 'no-known-route');
  assert.equal(queryGraph(graph, { x: 50, y: 30 }, { x: 65, y: 30 }).status, 'invalid-endpoint');
});

test('unrestricted search leaves the start-goal box for a long detour', () => {
  const graph = bakeGraph(map(240, 576, [{ id: 'wall', kind: 'building', x: 96, y: 0, w: 12, h: 480 }]), { radius: 6 });
  const from = { x: 60, y: 60 }, to = { x: 150, y: 60 };
  const result = queryGraph(graph, from, to);
  assert.equal(result.status, 'complete');
  assert.ok(result.path.some(p => p.y > 480));
  assert.ok(result.length > 800);
  const reference = queryGraph(graph, from, to, { heuristic: false });
  assert.equal(reference.status, 'complete');
  assert.ok(Math.abs(result.length - reference.length) < 1e-7);
});

test('support includes clearance overlap and filters unknown chunks', () => {
  const graph = bakeGraph(map(192, 96), { radius: 14, chunkSize: 96 });
  assert.deepEqual(graph.support({ x: 90, y: 48 }), [0, 1]);
  const from = { x: 36, y: 36 }, to = { x: 156, y: 36 };
  assert.equal(queryGraph(graph, from, to, { support: new Set([0]) }).status, 'no-known-route');
  assert.equal(queryGraph(graph, from, to, { support: new Set([0, 1]) }).status, 'complete');
  assert.ok(graph.boundaryEdges > 0);
  assert.ok(graph.boundaryNodes > 0);
});

test('sliced search resumes to the same deterministic route and work', () => {
  const graph = bakeGraph(map(240, 576, [{ id: 'wall', kind: 'building', x: 96, y: 0, w: 12, h: 480 }]), { radius: 6 });
  const from = { x: 60, y: 60 }, to = { x: 150, y: 60 };
  const full = queryGraph(graph, from, to);
  const search = beginQuery(graph, from, to);
  let sliced;
  do { sliced = search.step(7); } while (sliced.status === 'budget-exhausted');
  assert.deepEqual(sliced, full);
  assert.equal(queryGraph(graph, from, to, { budget: 1 }).status, 'budget-exhausted');
});

test('coarse samples can miss a real narrow passage while local refinement finds it', () => {
  const obstacles = [
    { id: 'top', kind: 'building', x: 55, y: 0, w: 10, h: 42 },
    { id: 'bottom', kind: 'building', x: 55, y: 54, w: 10, h: 42 },
  ];
  const from = { x: 24, y: 72 }, to = { x: 96, y: 72 };
  const coarse = bakeGraph(map(120, 96, obstacles), { spacing: 24, radius: 2 });
  const fine = bakeGraph(map(120, 96, obstacles), { spacing: 6, radius: 2 });
  assert.equal(queryGraph(coarse, from, to).status, 'no-known-route');
  assert.equal(queryGraph(fine, from, to).status, 'complete');
});

test('direct line uses no private search arrays; naive graph control can disable it', () => {
  const graph = bakeGraph(map(192, 96), { radius: 6 });
  const from = { x: 30, y: 30 }, to = { x: 150, y: 30 };
  const direct = queryGraph(graph, from, to);
  const sampled = queryGraph(graph, from, to, { direct: false });
  assert.equal(direct.status, 'complete');
  assert.equal(direct.privateBytes, 0);
  assert.ok(sampled.privateBytes > 0);
  assert.ok(sampled.length >= direct.length);
});

test('lazy hierarchy preserves fine graph route length and safe witness through a long detour', () => {
  const graph = bakeGraph(map(240, 576, [{ id: 'wall', kind: 'building', x: 96, y: 0, w: 12, h: 480 }]),
    { radius: 6, chunkSize: 96 });
  const hierarchy = createHierarchy(graph);
  const from = { x: 60, y: 60 }, to = { x: 150, y: 60 };
  const fine = queryGraph(graph, from, to, { heuristic: false, direct: false });
  const first = hierarchy.query(from, to, { direct: false });
  const second = hierarchy.query(from, to, { direct: false });
  assert.equal(first.status, fine.status);
  assert.ok(Math.abs(first.length - fine.length) < 1e-6);
  assert.ok(first.path.some(p => p.y > 480));
  for (let i = 1; i < first.path.length; i++) assert.ok(graph.clear(first.path[i - 1], first.path[i]));
  assert.equal(second.length, first.length);
  assert.ok(second.cacheHits > 0);
  assert.ok(first.localSearches > second.localSearches);
  assert.ok(first.localExpansions > second.localExpansions);
  assert.ok(hierarchy.stats().cacheBytes > 0);
});

test('hierarchy agrees with fine graph on corner crossing and disconnected components', () => {
  const cases = [
    { scene: map(192, 192), from: { x: 48, y: 48 }, to: { x: 150, y: 150 } },
    { scene: map(192, 192, [{ id: 'wall', kind: 'building', x: 95, y: 0, w: 2, h: 192 }]),
      from: { x: 48, y: 48 }, to: { x: 150, y: 150 } },
  ];
  for (const { scene, from, to } of cases) {
    const graph = bakeGraph(scene, { radius: 6, chunkSize: 96 });
    const fine = queryGraph(graph, from, to, { direct: false, heuristic: false });
    const coarse = createHierarchy(graph).query(from, to, { direct: false });
    assert.equal(coarse.status, fine.status);
    if (fine.status === 'complete') assert.ok(Math.abs(coarse.length - fine.length) < 1e-6);
  }
});

test('hierarchy matches unrestricted fine search across multiple routes and connector chunks', () => {
  const graph = bakeGraph(map(288, 192, [
    { id: 'one', kind: 'building', x: 72, y: 0, w: 12, h: 120 },
    { id: 'two', kind: 'building', x: 180, y: 72, w: 12, h: 120 },
  ]), { radius: 6, chunkSize: 96 });
  const hierarchy = createHierarchy(graph);
  const points = [
    { x: 30, y: 30 }, { x: 50, y: 150 }, { x: 100, y: 40 },
    { x: 150, y: 150 }, { x: 220, y: 40 }, { x: 260, y: 150 },
  ];
  for (const from of points) for (const to of points) {
    const fine = queryGraph(graph, from, to, { heuristic: false, direct: false });
    const coarse = hierarchy.query(from, to, { direct: false });
    assert.equal(coarse.status, fine.status);
    if (fine.status === 'complete') assert.ok(Math.abs(coarse.length - fine.length) < 1e-6,
      `${JSON.stringify(from)} -> ${JSON.stringify(to)}: ${coarse.length} vs ${fine.length}`);
  }
});
