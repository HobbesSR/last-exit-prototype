import test from 'node:test';
import assert from 'node:assert/strict';
import { emitWallRun } from '../map/micro/sdk.ts';

const h = { axis: 'h', x: 2, y: 5, length: 6 };
const v = { axis: 'v', x: 2, y: 5, length: 6 };
const options = { cellSize: 10, thickness: 0.25, offset: -0.125 };

test('wall runs follow either axis and may straddle or stand beside the guide', () => {
  assert.deepEqual(emitWallRun(h, options), [{ part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 20, y: 48.75, w: 60, h: 2.5 } }]);
  assert.deepEqual(emitWallRun(v, options), [{ part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 18.75, y: 50, w: 2.5, h: 60 } }]);
  assert.equal(emitWallRun(h, { ...options, offset: 0 })[0].shape.y, 50);
  assert.equal(emitWallRun(h, { ...options, offset: -0.25 })[0].shape.y, 47.5);
});

test('door, window and open gaps preserve along-run order at ends and in the middle', () => {
  const parts = emitWallRun(h, { ...options, openings: [
    { center: 0.5, length: 1, kind: 'open' },
    { center: 2.5, length: 1, kind: 'window' },
    { center: 5, length: 2, kind: 'door' },
  ] });
  assert.deepEqual(parts.map(p => p.part === 'gate' ? 'gate' : p.kind), ['building', 'window', 'building', 'gate']);
  assert.deepEqual(parts[0].shape, { kind: 'rect', x: 30, y: 48.75, w: 10, h: 2.5 });
  assert.deepEqual(parts[1].shape, { kind: 'rect', x: 40, y: 48.75, w: 10, h: 2.5 });
  assert.deepEqual(parts[3], { part: 'gate', x: 70, y: 50, w: 20, h: 2.5 });
  assert.deepEqual(emitWallRun(v, { ...options, openings: [{ center: 3, length: 6, kind: 'door' }] }),
    [{ part: 'gate', x: 20, y: 80, w: 2.5, h: 60 }]);
  assert.deepEqual(emitWallRun(h, { ...options, openings: [{ center: 3, length: 6, kind: 'open' }] }), []);
});

test('two openings and corner trims leave only owned wall lengths', () => {
  const parts = emitWallRun(v, { cellSize: 10, thickness: 0.25, offset: 0, trimStart: 0.5, trimEnd: 0.5,
    openings: [{ center: 1.5, length: 1, kind: 'open' }, { center: 3.5, length: 1, kind: 'window' }] });
  assert.deepEqual(parts.map(p => p.shape?.h), [5, 10, 10, 15]);
  assert.deepEqual(parts.map(p => p.shape?.y), [55, 70, 80, 90]);
});

test('a whole-number cell size keeps the hut wall and gate formulas on both axes', () => {
  const size = 37, span = 4 * size, thick = 0.25 * size, gap = 2 * size;
  const open0 = (span - gap) / 2, open1 = (span + gap) / 2;
  const horizontal = emitWallRun({ axis: 'h', x: 0, y: 4, length: 4 },
    { cellSize: size, thickness: 0.25, offset: -0.25, openings: [{ center: 2, length: 2, kind: 'door' }] });
  assert.deepEqual(horizontal, [
    { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 0, y: span - thick, w: open0, h: thick } },
    { part: 'gate', x: span / 2, y: span - thick / 2, w: gap, h: thick },
    { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: open1, y: span - thick, w: span - open1, h: thick } },
  ]);
  const vertical = emitWallRun({ axis: 'v', x: 4, y: 0, length: 4 },
    { cellSize: size, thickness: 0.25, offset: -0.25, trimStart: 0.25, trimEnd: 0.25,
      openings: [{ center: 2, length: 2, kind: 'window' }] });
  assert.deepEqual(vertical, [
    { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: span - thick, y: thick, w: thick, h: open0 - thick } },
    { part: 'obstacle', kind: 'window', shape: { kind: 'rect', x: span - thick, y: open0, w: thick, h: open1 - open0 } },
    { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: span - thick, y: open1, w: thick, h: span - thick - open1 } },
  ]);
});

test('invalid or overlapping openings are rejected without mutating input', () => {
  const openings = [{ center: 3.5, length: 1, kind: 'window' }, { center: 1.5, length: 1, kind: 'open' }];
  emitWallRun(h, { ...options, openings });
  assert.equal(openings[0].center, 3.5);
  for (const bad of [
    [{ center: 0.4, length: 1, kind: 'door' }],
    [{ center: 6, length: 2, kind: 'open' }],
    [{ center: 2, length: 2, kind: 'open' }, { center: 2.5, length: 1, kind: 'window' }],
    [{ center: 1, length: 0, kind: 'door' }],
  ]) assert.throws(() => emitWallRun(h, { ...options, openings: bad }), RangeError);
  assert.throws(() => emitWallRun(h, { ...options, trimStart: 4, trimEnd: 3 }), RangeError);
  for (const cellSize of [7.3, 0, -10, Infinity]) assert.throws(() => emitWallRun(h, { ...options, cellSize }), RangeError);
});
