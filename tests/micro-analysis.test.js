import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegion, canonicalCells, cellKey, connectedComponents, findNeckCuts, growRegion, shortestCellPath, WorkBudget, WorkBudgetExceededError, createWorkBudget } from '../map/micro/decomposition/analysis.ts';

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
  for (const options of [{ maxWidth: 0 }, { minComponentArea: 0 }, { limit: -1 }, { maxWidth: Infinity }, { limit: 1.5 }]) assert.throws(() => findNeckCuts(dumbbell, options));
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
  assert.throws(() => canonicalCells([{ x: Number.MAX_SAFE_INTEGER, y: 0 }]), /safe integers.*offsets/);
  assert.deepEqual(analyzeRegion([]), { cells: [], area: 0, bounds: { x: 0, y: 0, w: 0, h: 0, area: 0 }, components: [], holes: [], boundary: [], perimeter: 0, rectangularity: 0, xMonotone: true, yMonotone: true, depth: [], localWidth: [], articulationCells: [], maximalRectangles: [] });
});


test('analysis accepts dimensions above former SDK caps when counted work fits', () => {
  const input = Array.from({ length: 65 }, (_, x) => ({ x, y: 0 }));
  const analysis = analyzeRegion(input);
  assert.equal(analysis.bounds.w, 65);
  assert.equal(analysis.area, 65);
  assert.deepEqual(analysis.maximalRectangles, [{ x: 0, y: 0, w: 65, h: 1, area: 65 }]);
  const many = Array.from({ length: 4097 }, (_, x) => ({ x, y: 0 }));
  assert.equal(canonicalCells(many).length, 4097);
  assert.equal(connectedComponents(many).length, 1);
  assert.equal(growRegion(input, [input[0]], { maxArea: 4097 }).length, 65);
  assert.deepEqual(findNeckCuts(input, { maxWidth: 65, minComponentArea: 4097, limit: 65 }), []);
});

test('shared budgets count deterministic work and refuse complete calls without partial results', () => {
  const input = cells(['###', '#.#', '###']);
  const operations = [
    budget => canonicalCells(input, budget),
    budget => connectedComponents(input, budget),
    budget => analyzeRegion(input, budget),
    budget => findNeckCuts(input, { minComponentArea: 1 }, budget),
    budget => growRegion(input, [input[0]], {}, budget),
    budget => shortestCellPath(input, input[0], input.at(-1), budget),
  ];
  for (const operation of operations) {
    const measured = createWorkBudget(1_000_000), result = operation(measured);
    assert.ok(measured.used > 0);
    const exact = new WorkBudget(measured.used);
    assert.deepEqual(operation(exact), result);
    assert.equal(exact.used, measured.used);
    const short = new WorkBudget(measured.used - 1);
    assert.throws(() => operation(short), error => error instanceof WorkBudgetExceededError
      && error.code === 'DECOMPOSITION_WORK_BUDGET_EXCEEDED' && error.limit === short.limit && error.used === short.used && error.used > error.limit);
  }
  const shared = new WorkBudget(1000);
  canonicalCells(input, shared); const first = shared.used;
  canonicalCells(input, shared); assert.equal(shared.used, first * 2);
  assert.equal(new WorkBudget(Number.MAX_SAFE_INTEGER).limit, Number.MAX_SAFE_INTEGER);
  for (const limit of [-1, .5, Infinity, NaN]) assert.throws(() => new WorkBudget(limit));
});

test('sparse bounding boxes fail by work budget before huge scans or allocations', () => {
  const input = [{ x: -Number.MAX_SAFE_INTEGER + 2, y: 0 }, { x: Number.MAX_SAFE_INTEGER - 2, y: 0 }];
  assert.equal(canonicalCells(input).length, 2);
  const budget = new WorkBudget(1000);
  assert.throws(() => analyzeRegion(input, budget), error => error instanceof WorkBudgetExceededError && error.used > error.limit);
  // Translation alone does not change accounting or geometry topology.
  const small = cells(['##', '.#']), translated = small.map(c => ({ x: c.x + 1_000_000, y: c.y - 1_000_000 }));
  const a = new WorkBudget(), b = new WorkBudget();
  analyzeRegion(small, a); analyzeRegion(translated, b); assert.equal(a.used, b.used);
});


test('rectangle scans and repeated neck connectivity exhaust deterministically', () => {
  const square = Array.from({ length: 256 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16) }));
  const corridor = Array.from({ length: 128 }, (_, x) => ({ x, y: 0 }));
  const cases = [
    // Linear topology, run widths and Tarjan fit; scanning rectangle row pairs does not.
    { limit: 24_000, run: budget => analyzeRegion(square, budget) },
    // Input, candidate runs and initial connectivity fit; repeated removal floods do not.
    { limit: 5_000, run: budget => findNeckCuts(corridor, { minComponentArea: 1 }, budget) },
  ];
  for (const { limit, run } of cases) {
    const charges = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const budget = new WorkBudget(limit);
      assert.throws(() => run(budget), error => error instanceof WorkBudgetExceededError && error.used > limit);
      charges.push(budget.used);
      assert.throws(() => budget.spend(0), WorkBudgetExceededError);
    }
    assert.equal(charges[0], charges[1]);
  }
});
