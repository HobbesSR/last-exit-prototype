import test from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, compareCells } from '../map/kernel/cell.ts';
import { cellKey as analysisCellKey } from '../map/micro/decomposition/analysis.ts';
import { OPPOSITE } from '../map/micro/port-terms.ts';

test('cell keys are x,y, including negative and zero coordinates', () => {
  assert.equal(cellKey({ x: 3, y: -2 }), '3,-2');
  assert.equal(cellKey({ x: -0, y: 0 }), '0,0');
  assert.equal(cellKey({ x: -11, y: 7, extra: 1 }), '-11,7');
  assert.equal(analysisCellKey, cellKey, 'the decomposition SDK re-exports the kernel key');
});

test('cell order is row-major and independent of input order', () => {
  const cells = [{ x: 1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -1 }, { x: -2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: -1 }];
  const expected = ['0,-1', '2,-1', '-2,0', '1,0', '-1,1', '0,1'];
  assert.deepEqual([...cells].sort(compareCells).map(cellKey), expected);
  assert.deepEqual([...cells].reverse().sort(compareCells).map(cellKey), expected);
  assert.equal(compareCells({ x: 4, y: 2 }, { x: 4, y: 2 }), 0);
});

test('opposite sides face each other across a shared edge', () => {
  assert.deepEqual({ ...OPPOSITE }, { N: 'S', S: 'N', E: 'W', W: 'E' });
  assert.ok(Object.isFrozen(OPPOSITE));
});
