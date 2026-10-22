import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressedArea } from '../map/micro/addressed.ts';
import { unusedComponents } from '../map/micro/components.ts';
import { createRegionMask } from '../map/micro/geometry.ts';
import { polygon, rect } from '../shared/shape.ts';

const SIZE = 40;
const rectangle = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) =>
  ({ x: n % w, y: Math.floor(n / w) })).filter(({ x, y }) => keep(x, y));
const area = (cells = rectangle(6, 4)) => createAddressedArea(createRegionMask({ cells, cellSize: SIZE }));

test('an area addresses the owned cells it overlaps, not those it only touches', () => {
  const record = area();
  assert.equal(record.mark(rect(SIZE, SIZE, 2 * SIZE, SIZE)), true);
  assert.deepEqual(rectangle(6, 4).filter(c => record.addressed(c.x, c.y)), [{ x: 1, y: 1 }, { x: 2, y: 1 }]);
  assert.equal(record.addressed(0, 1), false);
  assert.equal(record.addressed(3, 1), false);
  assert.equal(record.unaddressed().length, 22);
});

test('a sliver addresses its whole cell', () => {
  const record = area();
  record.mark(rect(SIZE * 4.9, SIZE * 2.9, SIZE * 0.05, SIZE * 0.05));
  assert.equal(record.addressed(4, 2), true);
  assert.equal(record.unaddressed().length, 23);
});

test('areas may share a cell when they do not overlap, and an overlapping area is refused', () => {
  const record = area();
  assert.equal(record.mark(rect(0, 0, SIZE * 1.5, SIZE)), true);
  assert.equal(record.mark(rect(SIZE * 1.5, 0, SIZE * 1.5, SIZE)), true, 'shares cell 1,0 along an edge');
  assert.equal(record.mark(polygon(0, 0, [{ x: SIZE, y: SIZE / 2 }, { x: SIZE * 2, y: SIZE / 2 }, { x: SIZE * 2, y: SIZE * 2 }])), false);
  assert.equal(record.areas.length, 2);
  assert.equal(record.addressed(1, 1), false, 'a refused area records nothing');
  assert.equal(record.markCells([{ x: 1, y: 0 }]), false, 'a cell square overlaps an area already in it');
});

test('whole cells are marked all or none, skipping cells the region does not own', () => {
  const record = area();
  record.markCells([{ x: 5, y: 3 }]);
  assert.equal(record.markCells([{ x: 0, y: 0 }, { x: 9, y: 9 }, { x: 5, y: 3 }]), false);
  assert.equal(record.addressed(0, 0), false);
  assert.equal(record.markCells([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 9, y: 9 }]), true);
  assert.equal(record.addressed(0, 0), true);
  assert.equal(record.addressed(9, 9), false);
  assert.equal(record.areas.length, 2);
  // An area reaching past ownership addresses only owned cells.
  assert.equal(record.mark(rect(-SIZE, -SIZE, SIZE * 2.5, SIZE * 1.5)), false, 'overlaps cell 0,0');
  assert.equal(record.mark(rect(SIZE * 5, -SIZE, SIZE * 3, SIZE * 2)), true);
  assert.equal(record.addressed(5, 0), true);
});

test('unaddressed components follow the shared walk in owned order', () => {
  const cells = rectangle(7, 5, (x, y) => !(x === 3 && y < 4));
  const record = area(cells);
  record.mark(rect(0, SIZE * 2, SIZE * 7, SIZE));
  const marked = new Set(cells.filter(c => record.addressed(c.x, c.y)).map(c => `${c.x},${c.y}`));
  assert.deepEqual(record.unaddressedComponents(), unusedComponents(createRegionMask({ cells, cellSize: SIZE }).cells, marked));
  assert.equal(record.unaddressedComponents().length, 3);
});

test('an invalid shape throws rather than addressing nothing', () => {
  assert.throws(() => area().mark(rect(0, 0, 0, SIZE)), /valid convex shape/);
});
