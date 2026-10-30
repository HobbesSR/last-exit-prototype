import test from 'node:test';
import assert from 'node:assert/strict';
import { freePaths, locate, mapFreeSpace } from '../shared/free-space.ts';
import { meshReach, regionDomain } from '../shared/navigation/mesh-level.ts';
import { gridReach } from '../shared/navigation/grid-level.ts';
import { navigationClearance } from '../shared/map/navigation.ts';
import { canOccupy, sweptClear } from '../shared/movement.ts';
import { arena } from './helpers/arena.js';

// The bottom level of navigation (22.6, #422): the shape module's free space, eroded by a body's
// clearance and triangulated, with the 40-unit grid kept as the reference it replaces.

const CELL = 48;

/** An open map of `cols` × `rows` cells with the given obstacles and gates. */
const scene = (cols, rows, obstacles = [], gates = []) => arena({ cols, rows, cellSize: CELL, obstacles, gates }).map;

/** Regions side by side as columns of cells, `widths` cells wide and `height` tall. */
function strip(widths, height) {
  const cols = widths.reduce((a, b) => a + b, 0), owner = new Int32Array(cols * height).fill(-1);
  let left = 0;
  const regions = widths.map((width, index) => {
    for (let row = 0; row < height; row++) for (let col = left; col < left + width; col++) owner[row * cols + col] = index;
    const box = { x: left * CELL, y: 0, w: width * CELL, h: height * CELL };
    left += width;
    return { id: `r${index}`, box, portals: [] };
  });
  return { cellSize: CELL, cols, rows: height, owner, regions, portals: [] };
}

/** Every segment of a path, swept at the body's navigation clearance. */
function sweepsClear(map, path, radius) {
  return path.points.slice(1).every((p, i) => sweptClear(map, path.points[i], p, radius));
}

test('the passages 42.1 found the 24- and 40-unit grids disconnect are connected', () => {
  // A wall across the patch with one gap: 40 units for a contestant, 60 for a gladiator.
  for (const [role, gap] of [['contestant', 40], ['gladiator', 60]]) {
    const map = scene(8, 4, [{ id: 'a', kind: 'wall', x: 180, y: 0, w: 10, h: 48 - gap / 2 }, { id: 'b', kind: 'wall', x: 180, y: 48 + gap / 2, w: 10, h: 192 - 48 - gap / 2 }]);
    const graph = strip([8], 4), from = { x: 130, y: 130 }, to = { x: 230, y: 130 };
    assert.deepEqual(gridReach(map, role, graph)(from, [to], 0), [null], `${role}: the grid misses the gap`);
    const reach = meshReach(map, role, graph), [length] = reach(from, [to], 0);
    assert.ok(length > Math.hypot(100, 0) && length < 260, `${role}: through the gap, ${length}`);
    assert.deepEqual(reach.defects, []);
    const space = mapFreeSpace(map, 'patch', regionDomain(graph, 0), navigationClearance(role));
    const path = freePaths(space, from, [to], 0)[0];
    assert.ok(sweepsClear(map, path, navigationClearance(role)), `${role}: every segment sweeps clear`);
    assert.ok(path.points.some(p => p.y < 48 + gap / 2 && p.x > 170 && p.x < 200), `${role}: the path goes through the gap`);
  }
});

test('a gap narrower than the body is closed, however near it comes', () => {
  // 27 units for a contestant's 28-unit width, 49 for a gladiator's 50.
  for (const [role, gap] of [['contestant', 27], ['gladiator', 49]]) {
    const map = scene(8, 4, [{ id: 'a', kind: 'wall', x: 180, y: 0, w: 10, h: 96 - gap / 2 }, { id: 'b', kind: 'wall', x: 180, y: 96 + gap / 2, w: 10, h: 96 - gap / 2 }]);
    const graph = strip([8], 4);
    assert.deepEqual(meshReach(map, role, graph)({ x: 100, y: 96 }, [{ x: 280, y: 96 }], 0), [null], role);
  }
});

test('a path never crosses a wall thinner than the gap between two clear points either side', () => {
  const map = scene(4, 4, [{ id: 'thin', kind: 'wall', x: 38, y: 0, w: 4, h: 192 }]);
  const graph = strip([4], 4), from = { x: 20, y: 100 }, to = { x: 100, y: 100 };
  assert.ok(canOccupy(map, from.x, from.y, 14) && canOccupy(map, to.x, to.y, 14), 'both points are clear');
  assert.deepEqual(meshReach(map, 'contestant', graph)(from, [to], 0), [null]);
});

test('a round obstacle is rounded by its analytic circle, not its outline', () => {
  const map = scene(8, 6, [{ id: 'tree', kind: 'tree', x: 192, y: 144, w: 80, h: 80, r: 40 }]);
  const graph = strip([8], 6), from = { x: 60, y: 144 }, to = { x: 330, y: 144 };
  for (const role of ['contestant', 'gladiator']) {
    const clearance = navigationClearance(role), space = mapFreeSpace(map, 'trees', regionDomain(graph, 0), clearance);
    const path = freePaths(space, from, [to], 0)[0];
    assert.ok(path.points.length > 2, `${role}: the path bends around the tree`);
    assert.ok(sweepsClear(map, path, clearance), `${role}: every segment sweeps clear of the circle`);
    const reach = meshReach(map, role, graph), [length] = reach(from, [to], 0);
    assert.ok(Math.abs(length - path.length) < 1e-9 && length > to.x - from.x);
    assert.deepEqual(reach.defects, []);
  }
});

test('a body pressed against a wall connects at its own radius, never through the wall', () => {
  // A contestant 13 units from a wall's face: clear at its body radius, inside navigation clearance.
  const map = scene(6, 4, [{ id: 'wall', kind: 'wall', x: 140, y: 0, w: 12, h: 150 }]);
  const graph = strip([6], 4), pressed = { x: 127, y: 60 }, beyond = { x: 200, y: 60 }, near = { x: 60, y: 60 };
  assert.ok(canOccupy(map, pressed.x, pressed.y, 12) && !canOccupy(map, pressed.x, pressed.y, 14));
  const reach = meshReach(map, 'contestant', graph);
  const [toNear, toBeyond] = reach(pressed, [near, beyond], 0);
  assert.ok(Math.abs(toNear - 67) < 2, `straight back from the wall, ${toNear}`);
  assert.ok(toBeyond > 2 * (150 - 60), `around the wall's end, not through it, ${toBeyond}`);
  assert.deepEqual(reach.defects, []);
});

test('a closed door blocks, and opening it rebuilds only the meshes it borders', () => {
  // A wall with one doorway between two regions, and a third region well away.
  const door = { id: 'door-1', kind: 'door', x: 192, y: 96, w: 12, h: 72, open: false, locked: false };
  const map = scene(12, 4, [{ id: 'n', kind: 'wall', x: 186, y: 0, w: 12, h: 60 }, { id: 's', kind: 'wall', x: 186, y: 132, w: 12, h: 60 }], [door]);
  const graph = strip([4, 4, 4], 4), from = { x: 120, y: 96 }, to = { x: 264, y: 96 };
  const domains = [0, 1, 2].map(r => regionDomain(graph, r)), meshes = () => domains.map((d, r) => mapFreeSpace(map, `r${r}`, d, 14));
  const closed = meshes();
  assert.equal(locate(closed[0], { x: 192, y: 96 }), -1, 'the closed door is solid');
  assert.deepEqual(meshReach(map, 'contestant', graph, false)(from, [to], 0), [null]);
  door.open = true;
  const opened = meshes();
  assert.notEqual(opened[0], closed[0]);
  assert.notEqual(opened[1], closed[1]);
  assert.equal(opened[2], closed[2], 'a region the door does not border keeps its mesh');
  assert.ok(locate(opened[0], { x: 192, y: 96 }) >= 0);
  const [length] = meshReach(map, 'contestant', graph, false)(from, [to], 0);
  assert.ok(Math.abs(length - 144) < 1e-6, `straight through the doorway, ${length}`);
});

test('building a mesh is deterministic and leaves the map as it was', () => {
  const map = scene(8, 6, [{ id: 'a', kind: 'wall', x: 100, y: 40, w: 60, h: 12 }, { id: 'b', kind: 'crate', x: 200, y: 150, w: 40, h: 40 }, { id: 't', kind: 'tree', x: 300, y: 80, w: 40, h: 40, r: 20 }]);
  const before = JSON.stringify(map), graph = strip([8], 6);
  const first = mapFreeSpace(map, 'a', regionDomain(graph, 0), 14), second = mapFreeSpace(structuredClone(map), 'a', regionDomain(graph, 0), 14);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(map), before);
});
