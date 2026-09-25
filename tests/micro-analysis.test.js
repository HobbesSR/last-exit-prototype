import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegion, canonicalCells, cellKey, connectedComponents, findNeckCuts, growRegion, shortestCellPath } from '../shared/map/micro/decomposition/analysis.ts';

const cells = (rows) => rows.flatMap((row, y) => [...row].flatMap((value, x) => value === '#' ? [{ x, y }] : []));

test('analysis identifies ring holes, boundary ownership and perimeter', () => {
  const ring = cells(['###', '#.#', '###']);
  const analysis = analyzeRegion(ring);
  assert.equal(analysis.area, 8); assert.deepEqual(analysis.holes, [[{ x: 1, y: 1 }]]);
  assert.equal(analysis.perimeter, 16); assert.equal(analysis.boundary.filter(e => e.kind === 'hole').length, 4);
  assert.deepEqual(analysis.boundary[0], { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, cell: { x: 0, y: 0 }, kind: 'outer' });
  assert.ok(analysis.boundary.every(e => Number.isInteger(e.a.x) && Number.isInteger(e.b.y)));
});

test('concavity, monotonicity, depth and local width are grid properties', () => {
  const shape = cells(['###', '#..', '###']);
  const analysis = analyzeRegion(shape);
  assert.equal(analysis.xMonotone, true); assert.equal(analysis.yMonotone, false);
  const block = analyzeRegion(cells(['###', '###', '###']));
  assert.equal(block.depth.find(d => d.cell.x === 1 && d.cell.y === 1).distance, 2);
  assert.equal(block.localWidth.find(d => d.cell.x === 1 && d.cell.y === 1).width, 3);
});

test('maximal rectangles include distinct useful candidates and use stable ordering', () => {
  const analysis = analyzeRegion(cells(['###.', '####', '.###']));
  assert.deepEqual(analysis.maximalRectangles.slice(0, 3), [
    { x: 0, y: 0, w: 3, h: 2, area: 6 },
    { x: 1, y: 0, w: 2, h: 3, area: 6 },
    { x: 1, y: 1, w: 3, h: 2, area: 6 },
  ]);
});

test('neck proposals retain cut cells and describe the resulting dumbbell components', () => {
  const dumbbell = cells(['###.###', '#######', '###.###']);
  const cuts = findNeckCuts(dumbbell, { minComponentArea: 8 });
  const cut = cuts.find(c => c.orientation === 'vertical' && c.cells.length === 1 && c.cells[0].x === 3 && c.cells[0].y === 1);
  assert.ok(cut); assert.equal(cut.id, 'neck-v-3-1-1'); assert.deepEqual(cut.resultingAreas, [9, 9]);
  assert.equal(dumbbell.some(c => c.x === 3 && c.y === 1), true);
});

test('neck cuts are full bounded cross-sections and do not invent cuts for disconnected inputs', () => {
  const disconnected = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 0 }];
  assert.deepEqual(findNeckCuts(disconnected, { minComponentArea: 1 }), []);
  const dumbbell = cells(['###.###', '#######', '###.###']);
  assert.equal(findNeckCuts(dumbbell, { maxWidth: 64, minComponentArea: 8 }).some(c => c.orientation === 'horizontal' && c.cells.length < 7 && c.cells[0].y === 1), false);
  for (const options of [{ maxWidth: 65 }, { minComponentArea: 4097 }, { limit: 65 }]) assert.throws(() => findNeckCuts(dumbbell, options));
});

test('articulation cells are exact even when inputs contain several components', () => {
  const input = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 9, y: 9 }];
  assert.deepEqual(analyzeRegion(input).articulationCells, [{ x: 1, y: 0 }]);
  assert.deepEqual(connectedComponents(input).map(part => part.length), [3, 1]);
});

test('growth is lowest cost connected frontier and paths are deterministic', () => {
  const mask = cells(['###', '###', '###']);
  const grown = growRegion(mask, [{ x: 1, y: 1 }], { maxArea: 4, cost: c => c.x === 0 ? 0 : c.y });
  assert.deepEqual(grown, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }]);
  assert.throws(() => growRegion(mask, [{ x: 1, y: 1 }], { eligible: c => c.x !== 1 }));
  assert.deepEqual(shortestCellPath(cells(['##.', '.##', '.##']), { x: 0, y: 0 }, { x: 2, y: 2 }), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]);
  assert.equal(shortestCellPath(mask, { x: 9, y: 9 }, { x: 1, y: 1 }), null);
});

test('input order does not matter, invalid input fails, and analysis does not mutate inputs', () => {
  const input = [{ x: 1, y: 0 }, { x: 0, y: 0 }], before = structuredClone(input);
  assert.deepEqual(canonicalCells(input), [{ x: 0, y: 0 }, { x: 1, y: 0 }]); assert.equal(cellKey(input[0]), '1,0');
  analyzeRegion(input); assert.deepEqual(input, before);
  assert.throws(() => canonicalCells([{ x: .5, y: 0 }]));
  assert.throws(() => canonicalCells([{ x: 0, y: 0 }, { x: 0, y: 0 }]));
  assert.throws(() => canonicalCells([{ x: 513, y: 0 }]));
  assert.deepEqual(analyzeRegion([]), { cells: [], area: 0, bounds: { x: 0, y: 0, w: 0, h: 0, area: 0 }, components: [], holes: [], boundary: [], perimeter: 0, rectangularity: 0, xMonotone: true, yMonotone: true, depth: [], localWidth: [], articulationCells: [], maximalRectangles: [] });
});
