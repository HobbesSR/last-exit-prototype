import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeStarts } from '../map/micro/geometry.ts';

function wholeGridStarts(step, box, width, height, a) {
  const point = i => ({ x: box.x + i % width * step, y: box.y + Math.floor(i / width) * step });
  const nearby = [];
  for (let i = 0; i < width * height; i++) {
    if (Math.hypot(point(i).x - a.x, point(i).y - a.y) <= step * 3) nearby.push(i);
  }
  nearby.sort((i, j) => Math.hypot(point(i).x - a.x, point(i).y - a.y) - Math.hypot(point(j).x - a.x, point(j).y - a.y));
  return nearby;
}

function compare(mask, a, label) {
  const step = mask.cellSize / 2, box = mask.bounds;
  const width = Math.round(box.w / step) + 1, height = Math.round(box.h / step) + 1;
  assert.deepEqual(routeStarts(step, box, width, height, a), wholeGridStarts(step, box, width, height, a), label);
}

test('local start enumeration preserves captured entrance candidates and exact tie ordering', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/route-start-cases.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 129);
  for (const c of cases) compare(c.mask, c.a, c.id);
});

test('local starts preserve negative, off-grid, clipped and outside-domain candidates', () => {
  for (const cellSize of [1, 40, 48]) for (const origin of [-480, 0, 1000000]) {
    const mask = { cellSize, bounds: { x: origin, y: origin, w: cellSize * 12, h: cellSize * 10 } };
    for (const [x, y] of [[0, 0], [-.33, .27], [.5, .5], [5.13, 4.73], [12, 10], [13, 11], [-4, -4], [16, 15]]) {
      compare(mask, { x: origin + x * cellSize, y: origin + y * cellSize }, `${cellSize}/${origin}/${x},${y}`);
    }
  }
});
