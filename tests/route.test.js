import test from 'node:test';
import assert from 'node:assert/strict';
import { gridRoute, navigationGrid } from '../map/tools/route.ts';
import { TILE } from '../shared/movement.ts';
import { openArea } from './helpers/arena.js';

test('a body pressed against a thin wall routes from its own side of it', () => {
  // A 12-unit wall, like a building's, splits the map. A contestant touching its south face has its
  // own tile blocked, and the first open tile in search order is across the wall to the north.
  const wall = { id: 'wall', kind: 'building', x: 0, y: 116, w: 400, h: 12 };
  const map = { width: 400, height: 400, playableArea: openArea(400, 400, 100), obstacles: [wall], gates: [], buildings: [] };
  const bounds = { x: 0, y: 0, width: 400 / TILE, height: 400 / TILE };
  const from = { x: 200, y: 140 }, to = { x: 200, y: 340 };
  const route = gridRoute(map, 'contestant', bounds, from, to);
  assert.ok(route?.length, 'a route on the near side exists');
  assert.ok(route.every(([, y]) => (y + 0.5) * TILE > wall.y + wall.h), 'no step is across the wall');
});

test('navigation caches follow map identity, doors, obstacle replacement and append', () => {
  const m = { width: 1200, height: 1200, playableArea: openArea(1200, 1200, 100), obstacles: [], gates: [{ id: 'door', x: 620, y: 620, w: 20, h: 100, open: false, locked: false }] };
  const bounds = { x: 13, y: 13, width: 5, height: 5 };
  const grid = () => navigationGrid(m, 'contestant', bounds);
  const closed = grid(); assert.equal(grid(), closed);
  assert.notEqual(navigationGrid(structuredClone(m), 'contestant', bounds), closed);
  m.gates[0].open = true;
  const opened = grid(); assert.notDeepEqual(opened, closed); assert.equal(grid(), opened);
  m.obstacles = [{ id: 'wall', x: 600, y: 600, w: 40, h: 40 }];
  const replaced = grid(); assert.notDeepEqual(replaced, opened);
  m.obstacles.push({ id: 'wall2', x: 540, y: 540, w: 40, h: 40 });
  assert.notDeepEqual(grid(), replaced);
  m.gates[0].open = false;
  const unlocked = navigationGrid(m, 'contestant', bounds, true);
  m.gates[0].locked = true;
  assert.notDeepEqual(navigationGrid(m, 'contestant', bounds, true), unlocked);
});
