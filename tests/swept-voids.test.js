import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryContact, staticShapes, sweptUpload } from '../shared/simulation/swept.ts';
import { arena } from './helpers/arena.js';

// What the core sweeps for a shot (27.2 R6, `rust/core/src/swept.rs`) is uploaded from `sweptUpload`: the playable
// mask's voids are shapes that block shots, past the obstacles' own (which a window or fence does not).
const map = hole => {
  const { map } = arena({ cols: 100, rows: 40, cellSize: 10, obstacles: [{ id: 'window', kind: 'window', x: 500, y: 40, w: 2, h: 20 }] });
  if (hole) map.playableArea.rows[5].runs = [[0, 4], [5, 100]];
  return map;
};

test('a thin playable-mask void blocks a shot that would otherwise re-enter the field', () => {
  const a = { x: 30, y: 55 }, b = { x: 75, y: 55 };
  assert.equal(geometryContact(map(false), true, a, b, 2), Infinity);
  const t = geometryContact(map(true), true, a, b, 2);
  assert.ok(t > 0 && t < 1, `contact ${t}`);
  const holed = map(true), { statics, shots } = sweptUpload(holed);
  assert.equal(statics.length, staticShapes(holed, false).length);
  assert.ok(statics.length > holed.obstacles.length, 'the void adds shapes after the obstacles');
  assert.ok(shots.slice(holed.obstacles.length).every(Boolean), 'and shots see every one');
  assert.equal(shots[0], false, 'while a window is see-through');
  assert.equal(geometryContact(map(false), true, { x: 450, y: 50 }, { x: 550, y: 50 }, 2), Infinity, 'so the window passes shots');
});
