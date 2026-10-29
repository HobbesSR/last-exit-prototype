import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCordWitness } from '../map/micro/cord-witness.ts';
import { createAccessMask, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

function brief(portals = []) {
  return { id: 'cord', seed: 1, type: 'test', cellSize: 32,
    cells: cellsOf(10,8), zones: [], portals };
}
const portals = [
  { id: 'left', axis: 'v', x: 0, y: 3, length: 2 },
  { id: 'right', axis: 'v', x: 10, y: 3, length: 2 },
];
function assertSwept(b, blockers, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  const mask = createAccessMask(b), radius = hunterClearance(b.cellSize);
  for (const path of result.witness.paths) for (let i = 0; i < path.length; i++)
    assert.ok(travelClear(mask, blockers, path[Math.max(i - 1, 0)], path[i], radius));
  for (const edge of result.witness.edges) assert.ok(travelClear(mask, blockers, edge.from, edge.to, radius));
}

test('cord mesh bends around an island and preserves valid previous paths', () => {
  const b = brief(portals), blockers = [rect(120, 64, 80, 128)];
  const found = discoverCordWitness(b, blockers);
  assertSwept(b, blockers, found);
  assert.equal(found.counters.meshBuilds, 1);
  assert.ok(found.witness.paths.some(path => path.length > 2));
  assert.equal(validatePortalReach({ ...b, blockers }, { search: 'thorough' }).valid, true);
  const reused = discoverCordWitness(b, blockers, [], found.witness, { maxMeshBuilds: 0 });
  assertSwept(b, blockers, reused);
  assert.deepEqual(reused.witness, found.witness);
  assert.equal(reused.counters.meshBuilds, 0);
  assert.deepEqual(discoverCordWitness(b, blockers), found);
});

test('a full physical cut refuses external reach; old paths never bypass sweeps', () => {
  const b = brief(portals), old = discoverCordWitness(b, []);
  const cut = [rect(144, -100, 32, 456)];
  const failed = discoverCordWitness(b, cut, [], old.witness);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'external');
  assert.equal(validatePortalReach({ ...b, blockers: cut }, { search: 'thorough' }).valid, false);
});

test('all long portal stands are required, including an obstructed far end', () => {
  const b = brief([{ ...portals[0], y: 1, length: 6 }, portals[1]]);
  const found = discoverCordWitness(b, []);
  assertSwept(b, [], found);
  const points = found.witness.paths.flat();
  for (const stand of portalStands(b).flatMap(p => p.points)) assert.ok(points.some(p => p.x === stand.x && p.y === stand.y));
  const failed = discoverCordWitness(b, [rect(-8, 180, 16, 20)]);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'external');
});

test('optional terminals impose interior obligations even without external portals', () => {
  const b = brief(), terminals = [{ x: 48, y: 128 }, { x: 272, y: 128 }];
  assertSwept(b, [rect(120, 64, 80, 128)], discoverCordWitness(b, [rect(120, 64, 80, 128)], terminals));
  const failed = discoverCordWitness(b, [rect(144, -100, 32, 456)], terminals);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'interior');
  const one = brief([portals[0]]);
  assert.deepEqual(discoverCordWitness(one, [rect(-8, 90, 16, 80)]).witness, { paths: [], edges: [] });
  assert.equal(discoverCordWitness(b, [], [{ x: -100, y: -100 }]).reason, 'interior');
  assertSwept(b, [], discoverCordWitness(b, [], [terminals[0]]));
});

test('coincident geometry is split into canonical shared edges and can separate on repair', () => {
  const b = brief(), root = { x: 48, y: 128 }, a = { x: 240, y: 80 }, z = { x: 240, y: 176 };
  const previous = { paths: [
    [root, { x: 176, y: 128 }, a],
    [root, { x: 112, y: 128 }, { x: 176, y: 128 }, z],
  ], edges: [] };
  const found = discoverCordWitness(b, [], [root, a, z], previous);
  assertSwept(b, [], found);
  assert.deepEqual(found.witness.edges.filter(e => e.from.y === 128 && e.to.y === 128), [
    { from: root, to: { x: 112, y: 128 } },
    { from: { x: 112, y: 128 }, to: { x: 176, y: 128 } },
  ]);
  const repaired = discoverCordWitness(b, [rect(128, 120, 16, 16)], [root, a, z], found.witness);
  assertSwept(b, [rect(128, 120, 16, 16)], repaired);
  assert.notDeepEqual(repaired.witness.edges, found.witness.edges);
  assert.equal(found.witness.edges.filter(e => e.from.x === 48 && e.to.x === 112).length, 1);
});

test('budgets stop deterministically without publishing partial geometry', () => {
  const b = brief(portals), blockers = [rect(120, 64, 80, 128)];
  for (const budget of [{ maxMeshBuilds: 0 }, { maxSweeps: 0 }, { maxPaths: 0 }]) {
    const result = discoverCordWitness(b, blockers, [], undefined, budget);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'budget');
    assert.equal('witness' in result, false);
    assert.deepEqual(discoverCordWitness(b, blockers, [], undefined, budget), result);
  }
  assert.throws(() => discoverCordWitness(b, [], [], undefined, { maxSweeps: -1 }), /budgets/);
  assert.throws(() => discoverCordWitness(b, [], [{ x: NaN, y: 0 }]), /terminals/);
  assert.throws(() => discoverCordWitness(b, [rect(0, 0, -1, 1)]), /blockers/);
  assert.throws(() => discoverCordWitness({ ...b, cellSize: 0 }, []), /cell size/);
});

test('portal, terminal and blocker input ordering does not affect geometry or counters', () => {
  const b = brief(portals), blockers = [rect(120, 64, 80, 128), rect(40, 40, 8, 8)];
  const terminals = [{ x: 272, y: 224 }, { x: 48, y: 224 }];
  const found = discoverCordWitness(b, blockers, terminals);
  assertSwept(b, blockers, found);
  assert.deepEqual(discoverCordWitness({ ...b, portals: [...b.portals].reverse(), cells: [...b.cells].reverse() },
    [...blockers].reverse(), [...terminals].reverse()), found);
  assert.deepEqual(discoverCordWitness(brief(), blockers, terminals), discoverCordWitness(brief(), [...blockers].reverse(), [...terminals].reverse()));
});

test('large translated coordinates retain local mesh discovery and sweep the world leads', () => {
  const offset = 1_000_000_000, world = offset * 32;
  const b = brief(portals);
  b.cells = b.cells.map(c => ({ x: c.x + offset, y: c.y + offset }));
  b.portals = b.portals.map(p => ({ ...p, x: p.x + offset, y: p.y + offset }));
  const blockers = [rect(world + 120, world + 64, 80, 128)];
  const result = discoverCordWitness(b, blockers);
  assertSwept(b, blockers, result);
  assert.equal(result.counters.meshBuilds, 1);
  assert.ok(result.witness.paths.some(p => p.length > 2));
});

test('mesh discovery preserves holes and disjoint row strips at fractional cell sizes', () => {
  for (const size of [16.25, 32, 48.125]) {
    const b = { ...brief(portals), cellSize: size,
      cells: cellsOf(10, 8).filter(c => !(c.x >= 4 && c.x < 6 && c.y >= 2 && c.y < 6)) };
    // The domain itself, rather than a blocker, forces the mesh around a hole.
    const found = discoverCordWitness(b, []);
    assertSwept(b, [], found);
    assert.equal(found.counters.meshBuilds, 1);
    assert.ok(found.witness.paths.some(p => p.length > 2));
    assert.deepEqual(discoverCordWitness({ ...b, cells: [...b.cells].reverse() }, []), found);
    const cut = { ...b, cells: b.cells.filter(c => c.x !== 4 || c.y === 0) };
    const failed = discoverCordWitness(cut, []);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'external');
  }
});
