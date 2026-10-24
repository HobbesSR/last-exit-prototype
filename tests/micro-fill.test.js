import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFill } from '../map/micro/fill.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const wall = (x, y, w, h) => ({ label: 'wall', x, y, template: { w, h, parts: [{ part: 'obstacle', shape: rect(0, 0, w, h), kind: 'ruin-wall' }] } });
const brief = (w, h) => ({ id: 'r', cells: cellsOf(w, h), cellSize: SIZE });

test('an empty region is one free rectangle', () => {
  const report = measureFill(brief(8, 6), []);
  assert.deepEqual(report.largest, { x: 0, y: 0, w: 8, h: 6 });
  assert.equal(report.rectangles.length, 1);
  assert.equal(report.freeCells, 48);
});

test('a wall splits the space and rectangles are disjoint, largest first', () => {
  // One cell wide wall down column 4 of a 9 × 4 region: 4 × 4 on the left, 4 × 4 on the right.
  const report = measureFill(brief(9, 4), [wall(4 * SIZE, 0, SIZE, 4 * SIZE)]);
  assert.equal(report.freeCells, 32);
  assert.deepEqual(report.rectangles.map(r => [r.w, r.h]), [[4, 4], [4, 4]]);
});

test('gaps narrower than the minimum are not counted', () => {
  const report = measureFill(brief(8, 2), []);
  assert.equal(report.largest, null);
  assert.equal(report.freeCells, 16);
});
