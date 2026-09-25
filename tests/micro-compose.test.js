import test from 'node:test';
import assert from 'node:assert/strict';
import { microExample } from '../shared/map/micro/examples.ts';
import { composeMicroRegions } from '../shared/map/micro/compose.ts';

function pair() {
  const a = microExample('depot', 41), b = microExample('ruins', 42);
  a.id = 'a'; b.id = 'b';
  b.cells.forEach(c => c.x += 24); b.ports.forEach(p => p.start.x += 24);
  return [a, b];
}
test('supplied adjacent regions share exact port contracts and remain stable when composed in another order', () => {
  const [a, b] = pair(), layout = composeMicroRegions([a, b]);
  assert.deepEqual(layout, composeMicroRegions([b, a]));
  assert.deepEqual(layout.connections, [{ a: 'a', b: 'b', portA: 'hunter-east', portB: 'hunter-west' }]);
  assert.equal(layout.regions.length, 2);
});
test('mismatched shared boundaries and overlapping ownership are rejected rather than repaired', () => {
  const [a, b] = pair(); b.ports[0].required = 'contestant'; b.ports[0].allowed = 'contestant';
  assert.throws(() => composeMicroRegions([a, b]), /matching floor\/ceiling/);
  const overlap = microExample('ruins', 42); overlap.id = 'other';
  assert.throws(() => composeMicroRegions([a, overlap]), /overlap/);
  assert.throws(() => composeMicroRegions([a, a]), /unique/);
});
