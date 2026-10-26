import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDelegation, prepareInitialPartition, validateBriefPartition } from '../map/micro/delegation.ts';

const cells = (x, width) => Array.from({ length: width * 6 }, (_, i) => ({ x: x + i % width, y: Math.floor(i / width) }));
const brief = (id, owned, portals = []) => ({ id, seed: id === 'parent' ? 7 : 19, type: 'open', cellSize: 40,
  cells: owned, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }], portals });
const crossing = { id: 'authored-frontage', axis: 'v', x: 3, y: 2, length: 2 };
const parent = brief('parent', cells(0, 6));
const left = brief('planner/left', cells(0, 3), [crossing]);
const right = { ...brief('planner/right', cells(3, 3), [crossing]), seed: 42, guidance: { style: 'yard' } };

test('initial partition preserves authored owners, seeds and frontages while inheriting margins', () => {
  const input = structuredClone([parent, left, right]);
  const children = prepareInitialPartition(parent, [left, right]);
  assert.deepEqual(validateBriefPartition(parent, children), []);
  assert.deepEqual(children.map(c => [c.id, c.seed, c.portals]), [
    [left.id, left.seed, [crossing]], [right.id, right.seed, [crossing]],
  ]);
  assert.deepEqual(children[1].guidance, right.guidance);
  assert.ok(children.every(c => c.fillCells.length < c.cells.length));
  assert.deepEqual([parent, left, right], input);
});

test('initial partition rejects missing ownership and unpaired frontages', () => {
  assert.throws(() => prepareInitialPartition(parent, [left]), /exhaust/);
  assert.throws(() => prepareInitialPartition(parent, [left, { ...right, portals: [] }]), /paired crossing/);
});

test('patch preparation still rejects complete handoff and retains the parent', () => {
  const result = prepareDelegation(parent, [{ key: 'all', type: 'open', cells: parent.cells }], { receiving: () => null });
  assert.equal(result.children.length, 0);
  assert.match(result.rejected[0].reason, /Complete-region handoff/);
  assert.deepEqual(result.retained.cells, parent.cells);
});
