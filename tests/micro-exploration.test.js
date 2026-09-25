import test from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, connectedComponents, validateDecompositionPlan } from '../shared/map/micro/sdk.ts';
import { decompositionExample, EXAMPLE_GENERATORS } from '../shared/map/micro/decomposition/example.ts';
import { exploreDecomposition } from '../shared/map/micro/decomposition/explore.ts';

function verifyNode(node) {
  if (!node.children.length) { assert.ok(node.stopReason, `${node.id} is explicitly terminal`); return; }
  assert.ok(node.plan, `${node.id} stores its local plan`);
  assert.deepEqual(validateDecompositionPlan(node.plan, EXAMPLE_GENERATORS), []);
  const parent = new Set(node.cells.map(cellKey)), seen = new Set();
  assert.ok(node.children.length >= 2);
  for (const child of node.children) {
    assert.ok(child.cells.length < node.cells.length, 'strict geometric progress');
    for (const cell of child.cells) { const key = cellKey(cell); assert.ok(parent.has(key)); assert.ok(!seen.has(key)); seen.add(key); }
    if (child.source === 'reserved' || child.source === 'forbidden') assert.equal(child.stopReason, 'constrained terminal');
    verifyNode(child);
  }
  assert.equal(seen.size, parent.size, 'children cover parent exactly');
}
function depth(node) { return node.children.length ? 1 + Math.max(...node.children.map(depth)) : 0; }
function leafSignature(root) {
  const walk = node => node.children.length ? node.children.flatMap(walk) : [`${node.source}:${node.cells.map(cellKey).sort().join(';')}`];
  return walk(root).sort().join('|');
}

test('bounded exploration is deterministic, serializable, and preserves every local partition', () => {
  const input = decompositionExample('neck'), before = structuredClone(input);
  const one = exploreDecomposition(input, { objective: 'balanced', maxDepth: 2, beamWidth: 4, maxExpansions: 24 });
  const two = exploreDecomposition(input, { objective: 'balanced', maxDepth: 2, beamWidth: 4, maxExpansions: 24 });
  assert.deepEqual(one, two); assert.deepEqual(input, before); assert.deepEqual(JSON.parse(JSON.stringify(one)), one);
  assert.equal(one.version, 'decomposition-exploration-1'); assert.equal(one.search.optimal, false);
  assert.ok(one.alternatives.length && one.alternatives.length <= 4);
  assert.equal(new Set(one.alternatives.map(a => leafSignature(a.root))).size, one.alternatives.length);
  for (const alternative of one.alternatives) verifyNode(alternative.root);
});

test('depth and expansion bounds are honored and rooms explores a neck beyond the first split', () => {
  const shallow = exploreDecomposition(decompositionExample('neck'), { objective: 'rooms', maxDepth: 1, beamWidth: 3, maxExpansions: 1 });
  assert.ok(shallow.search.expanded <= 1); assert.equal(shallow.search.limit, 1);
  for (const item of shallow.alternatives) assert.ok(depth(item.root) <= 1);
  const rooms = exploreDecomposition(decompositionExample('neck'), { objective: 'rooms', maxDepth: 2, beamWidth: 8, maxExpansions: 64 });
  assert.ok(rooms.alternatives.some(item => depth(item.root) >= 2), 'rooms continues into eligible pieces or residuals');
  assert.ok(rooms.search.expanded <= 64);
});

test('objective presets retain different geometry and preserve does not destroy a hole', () => {
  const rectangle = decompositionExample('rectangle');
  const rooms = exploreDecomposition(rectangle, { objective: 'rooms', maxDepth: 2, beamWidth: 8, maxExpansions: 64 });
  const preserve = exploreDecomposition(rectangle, { objective: 'preserve', maxDepth: 2, beamWidth: 8, maxExpansions: 64 });
  assert.notEqual(leafSignature(rooms.alternatives[0].root), leafSignature(preserve.alternatives[0].root));
  const ring = exploreDecomposition(decompositionExample('ring'), { objective: 'preserve', maxDepth: 2, beamWidth: 4, maxExpansions: 24 });
  assert.equal(ring.alternatives[0].root.children.length, 0, 'whole ring remains an explicit preserve choice');
  assert.equal(connectedComponents(ring.alternatives[0].root.cells).length, 1);
});

test('reserved and forbidden residual ownership is retained as terminal children', () => {
  const input = decompositionExample('rectangle');
  input.reserved = [{ x: 0, y: 0 }]; input.forbidden = [{ x: 19, y: 13 }];
  const result = exploreDecomposition(input, { maxDepth: 1, beamWidth: 8, maxExpansions: 24 });
  const constrained = result.alternatives.flatMap(a => a.root.children).filter(n => n.source === 'reserved' || n.source === 'forbidden');
  assert.ok(constrained.length); for (const node of constrained) assert.equal(node.stopReason, 'constrained terminal');
});

test('small and fully reserved regions remain explicit terminals, and split availability loses no cells', () => {
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  const small = exploreDecomposition({ id: 'small', cellSize: 40, cells });
  assert.equal(small.alternatives[0].root.source, 'residual');
  assert.equal(small.alternatives[0].root.cells.length, 4);
  const reserved = exploreDecomposition({ id: 'reserved', cellSize: 40, cells, reserved: cells });
  assert.equal(reserved.alternatives[0].root.source, 'reserved');
  assert.equal(reserved.alternatives[0].root.children.length, 0);
  const divided = decompositionExample('rectangle');
  divided.reserved = divided.cells.filter(c => c.x === 10);
  const result = exploreDecomposition(divided, { maxDepth: 2 });
  for (const alternative of result.alternatives) verifyNode(alternative.root);
});
