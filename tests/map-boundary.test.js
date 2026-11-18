import test from 'node:test';
import assert from 'node:assert/strict';
import { canOccupy, moveBody } from '../shared/movement.ts';
import { insideMap, openPlayableArea, playableAreaFromCells, playableAreaRects } from '../shared/playable-area.ts';

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

test('open playable ground covers partial edge cells and survives JSON without methods', () => {
  const area = JSON.parse(JSON.stringify(openPlayableArea(125, 75, 50)));
  assert.deepEqual([...playableAreaRects(area)], [
    { x: 0, y: 0, w: 150, h: 50 }, { x: 0, y: 50, w: 150, h: 50 },
  ]);
  const frame = { width: 125, height: 75, playableArea: area };
  assert.equal(insideMap(frame, 124, 74), true);
  assert.equal(insideMap(frame, 125, 74), false, 'map bounds still clip the partial cell');
});

test('cell encoding and rectangle reading retain sparse rows, holes and drawing order', () => {
  const area = playableAreaFromCells([{ x: 4, y: 3 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 3, y: 1 }], 50);
  assert.deepEqual(area, { cellSize: 50, rows: [
    { y: 1, runs: [[0, 2], [3, 4]] }, { y: 3, runs: [[4, 5]] },
  ] });
  assert.deepEqual([...playableAreaRects(JSON.parse(JSON.stringify(area)))], [
    { x: 0, y: 50, w: 100, h: 50 }, { x: 150, y: 50, w: 50, h: 50 }, { x: 200, y: 150, w: 50, h: 50 },
  ]);
  const frame = { width: 250, height: 200, playableArea: area };
  assert.equal(insideMap(frame, 125, 75), false, 'hole stays void');
  assert.equal(insideMap(frame, 175, 75), true);
  assert.equal(insideMap(frame, 225, 125), false, 'absent row stays void');
});

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

test('a map without a playable area is rejected, not bounded by a default shape', () => {
  const bare = { width: 250, height: 250, obstacles: [], gates: [] };
  assert.throws(() => insideMap(bare, 125, 125), /playableArea/);
  assert.throws(() => moveBody(bare, { x: 125, y: 125 }, { x: -1, y: -1 }, 10, 160), /playableArea/);
});
