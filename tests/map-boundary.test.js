import test from 'node:test';
import assert from 'node:assert/strict';
import { canOccupy, insideMap, moveBody } from '../shared/movement.ts';

const map = {
  width: 250, height: 250, obstacles: [], gates: [],
  playableArea: { cellSize: 50, rows: [
    { y: 0, runs: [[0, 5]] },
    { y: 1, runs: [[0, 5]] },
    { y: 2, runs: [[0, 2], [3, 5]] },
    { y: 3, runs: [[0, 3]] },
    { y: 4, runs: [[0, 3]] },
  ] },
};

test('mask occupancy respects concave edges, a hole, and the whole body disc', () => {
  assert.equal(insideMap(map, 125, 125, 0), false, 'hole centre');
  assert.equal(insideMap(map, 225, 175, 0), false, 'concave missing arm');
  assert.equal(insideMap(map, 125, 75, 0), true);
  assert.equal(insideMap(map, 89, 125, 10), true);
  assert.equal(insideMap(map, 91, 125, 10), false, 'disc crosses into hole');
  assert.equal(insideMap(map, 125, 89, 12), false, 'disc crosses a different hole side');
  assert.equal(insideMap(map, 245, 25, 6), false, 'outer rectangle clearance');
  assert.equal(canOccupy(map, 91, 125, 10), false);
  assert.equal(canOccupy(map, 89, 125, 10), true);
});

test('movement slides along a void wall and does not enter a deep hole', () => {
  const player = { x: 75, y: 125 };
  moveBody(map, player, { x: 1, y: 1 }, 10, 30);
  assert.ok(player.x <= 90.001, `x stayed outside hole: ${player.x}`);
  assert.ok(player.y > 125, `y advanced along wall: ${player.y}`);
  assert.equal(canOccupy(map, player.x, player.y, 10), true);
  const across = { x: 75, y: 125 };
  moveBody(map, across, { x: 1 }, 10, 90);
  assert.equal(canOccupy(map, across.x, across.y, 10), true);
  assert.ok(across.x < 100, `cannot tunnel through hole: ${across.x}`);
});

test('maps without a mask retain the diamond boundary', () => {
  const legacy = { width: 250, height: 250, obstacles: [], gates: [] };
  assert.equal(insideMap(legacy, 125, 125), true);
  assert.equal(insideMap(legacy, 25, 25), false);
  assert.equal(insideMap(legacy, 125, 39), false);
  const player = { x: 125, y: 125 };
  moveBody(legacy, player, { x: -1, y: -1 }, 10, 160);
  assert.deepEqual(player, { x: 89.571, y: 89.571 }, 'legacy SAT diamond correction is unchanged');
});
