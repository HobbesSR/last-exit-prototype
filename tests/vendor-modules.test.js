import test from 'node:test';
import assert from 'node:assert';
import { vendorModule } from '../server/vendor-modules.js';

test('vendorModule generates valid bundle for sat', () => {
  const code = vendorModule('sat');
  assert.ok(code.includes('loaded = []'), 'Should contain the bundle preamble');
  assert.ok(code.includes('export default require(0)'), 'Should export the main module');
  assert.ok(code.includes('var SAT = {};'), 'Should contain sat source code');
});

test('vendorModule generates valid bundle for pathfinding', () => {
  const code = vendorModule('pathfinding');
  assert.ok(code.includes('loaded = []'), 'Should contain the bundle preamble');
  assert.ok(code.includes('export default require(0)'), 'Should export the main module');
  assert.ok(code.includes('function AStarFinder'), 'Should contain pathfinding source code');
});
