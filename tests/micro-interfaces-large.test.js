import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInterfaces } from '../map/micro/decomposition/interfaces.ts';

test('interface measurements support more runs than a JavaScript argument list', () => {
  // Two connected combs have alternating contacts along their shared row.
  const a = [], b = [], width = 70_000;
  for (let x = 0; x < width; x++) {
    a.push({ x, y: 0 });
    b.push({ x, y: 2 });
    (x % 2 ? b : a).push({ x, y: 1 });
  }
  const [edge] = buildInterfaces([{ id: 'a', cells: a }, { id: 'b', cells: b }]);
  assert.equal(edge.runs.length, width * 2 - 1);
  assert.equal(edge.longestRun, 1);
  assert.equal(edge.length, width * 2 - 1);
});
