import test from 'node:test';
import assert from 'node:assert/strict';
import { rect } from '../shared/shape.ts';
import { createRegionMask, findRegionRoute } from '../map/micro/geometry.ts';
import { CELL_SCALE } from '../map/kernel/scale.ts';

// 52's widths through the region route search: a 2-cell doorway whose edges lie on whole cells
// is passable for a hunter, and a 1.5-cell squeeze admits a contestant and not a hunter (#175).
const SIZE = 40;
const body = radius => (radius + CELL_SCALE.clearanceMargin) * SIZE;
const hunter = body(CELL_SCALE.hunterRadius), contestant = body(CELL_SCALE.contestantRadius);
const at = (x, y) => ({ x: x * SIZE, y: y * SIZE });
const cellsOf = (x0, y0, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x0 + i % w, y: y0 + Math.floor(i / w) }));
const cells = (...boxes) => createRegionMask({ cellSize: SIZE, cells: boxes.flatMap(b => cellsOf(...b)) });
const wall = (x, y, w, h) => rect(x * SIZE, y * SIZE, w * SIZE, h * SIZE);
const route = (mask, blockers, a, b, radius) => findRegionRoute(mask, blockers, at(...a), at(...b), radius);

test('a 2-cell gap with whole-cell edges is passable for a hunter, straight through', () => {
  const mask = cells([0, 0, 12, 8]);
  // A wall across column 5, open for rows 3 and 4 only.
  const blockers = [wall(5, 0, 1, 3), wall(5, 5, 1, 3)];
  assert.ok(route(mask, blockers, [2, 1.5], [9, 6.5], hunter), 'hunter');
  assert.ok(route(mask, blockers, [2, 1.5], [9, 6.5], contestant), 'contestant');
});

test('a hunter turns into a 2-cell door off a 2-wide corridor', () => {
  const mask = cells([0, 4, 12, 2], [6, 0, 2, 4]);
  assert.ok(route(mask, [], [1, 5], [7, 1], hunter), 'door north off the corridor');
  assert.ok(route(mask, [], [7, 1], [1, 5], hunter), 'and back');
});

test('a 1.5-cell squeeze admits a contestant and not a hunter, straight through', () => {
  const mask = cells([0, 0, 12, 8]);
  // Open from row 3.25 to 4.75, centred on row 4.
  const blockers = [wall(5, 0, 1, 3.25), wall(5, 4.75, 1, 3.25)];
  assert.ok(route(mask, blockers, [2, 1.5], [9, 6.5], contestant), 'contestant');
  assert.equal(route(mask, blockers, [2, 1.5], [9, 6.5], hunter), null, 'hunter');
});

test('a 1.5-cell squeeze door off a 2-wide corridor admits a contestant and not a hunter', () => {
  const mask = cells([0, 4, 12, 2], [6, 0, 2, 4]);
  // The door column is narrowed to 1.5, from x 6.25 to 7.75, centred on 7.
  const blockers = [wall(6, 0, 0.25, 4), wall(7.75, 0, 0.25, 4)];
  assert.ok(route(mask, blockers, [1, 5], [7, 1], contestant), 'contestant');
  assert.equal(route(mask, blockers, [1, 5], [7, 1], hunter), null, 'hunter');
});
