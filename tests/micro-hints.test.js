import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryBoxFilter, boxesAgainstHints, hintedCells, hintErrors, portalMargin } from '../map/micro/hints.ts';
import { briefErrors } from '../map/micro/region-types.ts';

const cellsOf = (w, h, x0 = 0, y0 = 0) => Array.from({ length: w * h }, (_, i) => ({ x: x0 + i % w, y: y0 + Math.floor(i / w) }));
const key = c => `${c.x},${c.y}`;
// An 8 × 6 region at the origin. Its west face is hinted for rows 1 and 2, its north face for columns 5 to 7.
const region = {
  cells: cellsOf(8, 6),
  hints: [{ axis: 'v', x: 0, y: 1, length: 2 }, { axis: 'h', x: 5, y: 0, length: 3 }],
  portals: [{ id: 'p', axis: 'h', x: 1, y: 6, length: 3 }],
};

test('boundary spacing permits an edge attachment without bridging a rectangular region', () => {
  const filter = boundaryBoxFilter({ cells: cellsOf(8, 6) }, 2);
  assert.equal(filter.rectangular, true);
  assert.equal(filter.fits({ x: 0, y: 0, w: 4, h: 4 }), true);
  assert.equal(filter.fits({ x: 0, y: 0, w: 7, h: 4 }), false);
  assert.equal(filter.fits({ x: 0, y: 0, w: 4, h: 5 }), false);
  assert.equal(filter.fits({ x: -1, y: 0, w: 4, h: 4 }), false);
});

test('a concave region allows a fully hinted corner while keeping its remaining ring owned', () => {
  const cells = cellsOf(10, 10).filter(c => c.x < 6 || c.y < 6);
  const filter = boundaryBoxFilter({ cells, hints: [
    { axis: 'h', x: 0, y: 0, length: 10 }, { axis: 'v', x: 0, y: 0, length: 10 },
  ] }, 2);
  assert.equal(filter.rectangular, false);
  assert.equal(filter.fits({ x: 0, y: 0, w: 3, h: 3 }), true);
  assert.equal(boundaryBoxFilter({ cells }, 2).fits({ x: 0, y: 0, w: 3, h: 3 }), false);
  assert.equal(filter.fits({ x: 0, y: 0, w: 5, h: 5 }), false, 'the missing diagonal ring cannot be excused by an attachment');
});

test('hintedCells are the region cells beside hinted segments, in row order, once each', () => {
  assert.deepEqual(hintedCells(region).map(key), ['5,0', '6,0', '7,0', '0,1', '0,2']);
  assert.deepEqual(hintedCells({ cells: region.cells }), []);
});

test('boxes against a hint sit flush with it, inside the region, once each', () => {
  const boxes = boxesAgainstHints({ cells: region.cells, hints: [region.hints[0]] }, 2, 2);
  // A 2 × 2 box with its west side on x = 0 and touching rows 1 or 2: top row 0, 1 or 2.
  assert.deepEqual(boxes, [{ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 1, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 }]);
  // Against the north face, the box hangs below the line and may overhang the run's ends only inside the region.
  const north = boxesAgainstHints({ cells: region.cells, hints: [region.hints[1]] }, 3, 2).map(b => b.x);
  assert.deepEqual(north, [3, 4, 5]);
  assert.ok(boxesAgainstHints(region, 9, 1).length === 0, 'a box wider than the region never fits');
});

test('boxes against a hint on a face looking the other way extend back from the line', () => {
  const south = { cells: cellsOf(6, 4), hints: [{ axis: 'h', x: 1, y: 4, length: 2 }] };
  assert.deepEqual(boxesAgainstHints(south, 2, 2), [{ x: 0, y: 2, w: 2, h: 2 }, { x: 1, y: 2, w: 2, h: 2 }, { x: 2, y: 2, w: 2, h: 2 }]);
  const east = { cells: cellsOf(4, 6), hints: [{ axis: 'v', x: 4, y: 2, length: 1 }] };
  assert.deepEqual(boxesAgainstHints(east, 2, 3), [{ x: 2, y: 0, w: 2, h: 3 }, { x: 2, y: 1, w: 2, h: 3 }, { x: 2, y: 2, w: 2, h: 3 }]);
});

test('the portal margin leaves out cells beside a hint', () => {
  const plain = portalMargin({ cells: region.cells, portals: region.portals }, 2).map(key);
  assert.deepEqual(plain.slice(0, 3), ['0,4', '1,4', '2,4']);
  assert.equal(plain.length, 5 * 2 + 0, 'cells within one cell of the portal row, columns 0 to 4');
  const hinted = portalMargin({ ...region, hints: [{ axis: 'v', x: 0, y: 4, length: 2 }] }, 2).map(key);
  assert.ok(!hinted.includes('0,4') && !hinted.includes('0,5'));
  assert.equal(hinted.length, plain.length - 2);
});

test('a run that changes sides along a concave region is refused', () => {
  // Seven cells around (1, 0) and (1, 1): the region lies left of line x = 1 at row 0, right of it at row 1.
  const cells = [[0, 0], [0, -1], [1, -1], [2, -1], [2, 0], [2, 1], [1, 1]].map(([x, y]) => ({ x, y }));
  const split = { cells, hints: [{ axis: 'v', x: 1, y: 0, length: 2 }] };
  assert.match(hintErrors(split)[0], /one side/);
  // Each half alone is fine, and boxes are offered against both.
  const halves = { cells, hints: [{ axis: 'v', x: 1, y: 0, length: 1 }, { axis: 'v', x: 1, y: 1, length: 1 }] };
  assert.deepEqual(hintErrors(halves), []);
  assert.deepEqual(boxesAgainstHints(halves, 1, 1).map(key), ['0,0', '1,1']);
});

test('hints are checked as input: runs on the perimeter that avoid the portals', () => {
  assert.deepEqual(hintErrors(region), []);
  assert.deepEqual(hintErrors({ cells: region.cells }), []);
  assert.match(hintErrors({ ...region, hints: [{ axis: 'v', x: 3, y: 1, length: 2 }] })[0], /perimeter/);
  assert.match(hintErrors({ ...region, hints: [{ axis: 'h', x: 0, y: 6, length: 2 }, { axis: 'h', x: 2, y: 6, length: 1 }] }).join(';'), /overlaps a portal/);
  assert.match(hintErrors({ ...region, hints: 'wall' })[0], /bounded list/);
  assert.match(hintErrors({ ...region, hints: [{ axis: 'x', x: 0, y: 0, length: 1 }] })[0], /not a run/);
  const brief = { id: 'r', seed: 1, type: 'open', cellSize: 40, cells: region.cells, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: region.cells }], ...region };
  assert.deepEqual(briefErrors(brief), []);
  assert.match(briefErrors({ ...brief, hints: [{ axis: 'v', x: 3, y: 1, length: 2 }] }).join(';'), /perimeter/);
});
