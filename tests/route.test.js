import test from 'node:test';
import assert from 'node:assert/strict';
import { gridRoute } from '../shared/map/route.ts';
import { TILE } from '../shared/movement.ts';

test('a body pressed against a thin wall routes from its own side of it', () => {
  // A 12-unit wall, like a building's, splits the map. A contestant touching its south face has its
  // own tile blocked, and the first open tile in search order is across the wall to the north.
  const wall = { id: 'wall', kind: 'building', x: 0, y: 116, w: 400, h: 12 };
  const map = { width: 400, height: 400, obstacles: [wall], gates: [], buildings: [] };
  const bounds = { x: 0, y: 0, width: 400 / TILE, height: 400 / TILE };
  const from = { x: 200, y: 140 }, to = { x: 200, y: 340 };
  const route = gridRoute(map, 'contestant', bounds, from, to);
  assert.ok(route?.length, 'a route on the near side exists');
  assert.ok(route.every(([, y]) => (y + 0.5) * TILE > wall.y + wall.h), 'no step is across the wall');
});
