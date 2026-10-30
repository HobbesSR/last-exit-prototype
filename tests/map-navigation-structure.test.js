import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulateFreeSpace } from '../shared/free-space.ts';
import { rect } from '../shared/shape.ts';
import { measureMeshPockets, measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';

const sample = (status, ratio = null) => ({
  category: 'test', stratum: 'test', from: { x: 0, y: 0 }, to: { x: 10, y: 0 },
  fromRegion: 0, toRegion: 0, status, distance: 10,
  length: ratio === null ? null : ratio * 10, ratio,
});

function mesh(open, blocked = []) {
  return triangulateFreeSpace(open, open, blocked, 0);
}

test('route summaries use nearest-rank percentiles and count failure statuses', () => {
  const records = [2, 1, 1.5, 1.2, 1.8, 1.1, 1.4, 1.3, 1.6, 1.7]
    .map(ratio => sample('complete', ratio));
  records.push(sample('invalid-endpoint'), sample('search-miss'), sample('sweep-defect'), sample('search-miss'), sample('unreachable'));
  assert.deepEqual(summarizeRoutes(records), {
    attempted: 15, complete: 10, median: 1.4, p90: 1.8, shareAbove1_5: 0.4,
    invalidEndpoints: 1, unreachable: 1, searchMisses: 2, sweepDefects: 1,
  });
  assert.deepEqual(summarizeRoutes([sample('invalid-endpoint')]), {
    attempted: 1, complete: 0, median: null, p90: null, shareAbove1_5: null,
    invalidEndpoints: 1, unreachable: 0, searchMisses: 0, sweepDefects: 0,
  });
  assert.deepEqual(summarizeRoutes([]), {
    attempted: 0, complete: 0, median: null, p90: null, shareAbove1_5: null,
    invalidEndpoints: 0, unreachable: 0, searchMisses: 0, sweepDefects: 0,
  });
});

test('a rectangle and a loop around an obstacle have no qualifying dead ends', () => {
  const open = [rect(0, 0, 100, 100)];
  for (const blocked of [[], [rect(25, 25, 50, 50)]]) {
    const result = measureMeshPockets(mesh(open, blocked), 3, 15, 40);
    assert.equal(result.components, 1);
    assert.equal(result.area, 0);
    assert.equal(result.pockets.length, 0);
  }
});

test('room and corridor dead end is measured once and respects scale filters', () => {
  const space = mesh([rect(0, 0, 100, 100), rect(100, 45, 60, 10), rect(160, 30, 40, 40)]);
  const result = measureMeshPockets(space, 3, 15, 40);
  assert.equal(result.components, 1);
  // The far room alone is 1600 square units and the corridor adds 600 before erosion.
  assert.ok(result.area > 1500 && result.area < 2200, `dead-end area ${result.area}`);
  assert.ok(result.pockets.length > 1, 'fixture must exercise overlapping cuts');
  assert.ok(result.pockets.reduce((sum, pocket) => sum + pocket.area, 0) > result.area * 2);
  assert.equal(measureMeshPockets(space, 11, 15, 40).area, 0, 'opening narrower than minimum');
  assert.equal(measureMeshPockets(space, 3, 15, 2200).area, 0, 'pocket smaller than minimum area');
});


function syntheticRegion(elements = []) {
  const cells = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6) }));
  return { layout: { seed: 'synthetic' }, results: [{ version: 'region-2',
    brief: { id: 'room', seed: 'synthetic', type: 'open', cellSize: 48, cells, zones: [], portals: [] },
    elements, loot: [], coreElements: [{ kind: 'spawn', x: 48, y: 144 }, { kind: 'exit', x: 240, y: 144 }] }] };
}

test('structure measurement follows physical barriers and leaves the input unchanged', () => {
  const barrier = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(136, 60, 16, 168) }] } };
  const clear = syntheticRegion(), blocked = syntheticRegion([barrier]);
  const beforeClear = JSON.stringify(clear), beforeBlocked = JSON.stringify(blocked);
  const clearResult = measureNavigationStructure(clear), blockedResult = measureNavigationStructure(blocked);
  assert.equal(JSON.stringify(clear), beforeClear);
  assert.equal(JSON.stringify(blocked), beforeBlocked);
  for (let i = 0; i < clearResult.roles.length; i++) {
    const route = role => role.samples.find(sample => sample.category === 'spawn-exit');
    const straight = route(clearResult.roles[i]), detour = route(blockedResult.roles[i]);
    assert.equal(straight.status, 'complete');
    assert.equal(detour.status, 'complete');
    assert.equal(straight.ratio, 1);
    assert.ok(detour.ratio > 1.2, `barrier detour ratio ${detour.ratio}`);
    assert.ok(blockedResult.roles[i].regions[0].emptyAreaEstimate < clearResult.roles[i].regions[0].emptyAreaEstimate);
  }
});

test('reserve footprints do not count as physical structures', () => {
  const reserve = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'reserve', x: 80, y: 80, w: 128, h: 128 }] } };
  const clear = measureNavigationStructure(syntheticRegion());
  const reserved = measureNavigationStructure(syntheticRegion([reserve]));
  assert.deepEqual(reserved.roles.map(role => role.regions[0].emptyAreaEstimate),
    clear.roles.map(role => role.regions[0].emptyAreaEstimate));
});



test('walkable area is attributed to the cells of each unequal region', () => {
  const region = (id, x0, x1) => ({ version: 'region-2',
    brief: { id, seed: 'synthetic', type: 'open', cellSize: 48,
      cells: Array.from({ length: (x1 - x0) * 6 }, (_, i) => ({
        x: x0 + i % (x1 - x0), y: Math.floor(i / (x1 - x0)),
      })), zones: [], portals: [] }, elements: [], loot: [], coreElements: [] });
  const result = measureNavigationStructure({ layout: { seed: 'synthetic' },
    results: [region('left', 0, 1), region('right', 1, 6)] });
  for (const role of result.roles) {
    const [left, right] = role.regions;
    assert.ok(left.walkableArea <= 48 * 288);
    assert.ok(right.walkableArea <= 240 * 288);
    assert.ok(Math.abs(left.walkableArea + right.walkableArea - role.walkableArea) < 0.01);
    // Erosion removes clearance plus the mesh's 0.2 margin from the outer edges.
    const expectedLeft = (48 - role.clearance - 0.2) * (288 - 2 * (role.clearance + 0.2));
    assert.ok(Math.abs(left.walkableArea - expectedLeft) < 1,
      `left area ${left.walkableArea}, expected approximately ${expectedLeft}`);
  }
});

test('a wall separating valid endpoints reports an unreachable route', () => {
  const wall = { x: 0, y: 0, template: { w: 288, h: 288,
    parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(136, 0, 16, 288) }] } };
  const input = syntheticRegion([wall]), before = JSON.stringify(input);
  const result = measureNavigationStructure(input);
  assert.equal(JSON.stringify(input), before);
  for (const role of result.roles) {
    const route = role.samples.find(sample => sample.category === 'spawn-exit');
    assert.equal(route.status, 'unreachable');
    assert.equal(route.length, null);
    assert.equal(route.ratio, null);
    const summary = role.detour['spawn-exit/short:<6-cells'];
    assert.equal(summary.attempted, 1);
    assert.equal(summary.unreachable, 1);
    assert.equal(summary.invalidEndpoints, 0);
  }
});
