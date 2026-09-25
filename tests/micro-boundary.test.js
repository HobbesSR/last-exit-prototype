import test from 'node:test';
import assert from 'node:assert/strict';
import { inheritBoundaryPorts, pairedBoundaryPort, validateBoundaryComposition } from '../shared/map/micro/boundary.ts';
import { generateMicroRegion } from '../shared/map/micro/index.ts';
import { elementShapes } from '../shared/map/micro/geometry.ts';
import { rect } from '../shared/shape.ts';

const cells = (x, width) => Array.from({ length: width * 10 }, (_, i) => ({ x: x + i % width, y: Math.floor(i / width) }));
function example() {
  const parent = { cells: cells(0, 16), cellSize: 40, bodyProfile: 'cell', ports: [
    { id: 'macro-west', side: 'W', start: { x: 0, y: 3 }, length: 3, required: 'hunter', allowed: 'hunter' },
    { id: 'macro-east', side: 'E', start: { x: 15, y: 3 }, length: 3, required: 'hunter', allowed: 'hunter' },
  ] };
  const parts = [{ id: 'left', cells: cells(0, 8) }, { id: 'right', cells: cells(8, 8) }];
  const inherited = inheritBoundaryPorts(parent, parts);
  const join = { id: 'join', side: 'E', start: { x: 7, y: 3 }, length: 3, required: 'hunter', allowed: 'hunter' };
  const children = parts.map((part, i) => {
    const spec = { ...parent, ...part, seed: 77, builder: 'entry', entry: { count: 0 }, loot: { budget: 0, tier: 1 }, ports: [...inherited[part.id], i ? pairedBoundaryPort(join) : join] };
    const generated = generateMicroRegion(spec);
    return { ...spec, blockers: generated.elements.flatMap(e => elementShapes(e)) };
  });
  return { parent, children };
}

test('external and inter-child segment contracts compose after physical generation', () => {
  const { parent, children } = example(), before = structuredClone({ parent, children });
  const result = validateBoundaryComposition(parent, children);
  assert.deepEqual(result.errors, []);
  assert.ok(result.valid);
  assert.ok(result.routes.some(r => r.role === 'hunter' && r.to === 'macro-east'));
  assert.ok(result.routes.some(r => r.role === 'contestant' && r.to === 'macro-east'));
  assert.deepEqual({ parent, children }, before);
  assert.deepEqual(validateBoundaryComposition(parent, [...children].reverse()), result);
  // Replace one child's internals with another independently generated partition.
  // Its parent-facing ports remain unchanged, so the containing level need not know the strategy.
  const left = children[0], grandchildren = [{ id: 'left-west', cells: cells(0, 4) }, { id: 'left-east', cells: cells(4, 4) }];
  const inherited = inheritBoundaryPorts(left, grandchildren);
  const inner = { id: 'inner-join', side: 'E', start: { x: 3, y: 3 }, length: 3, required: 'hunter', allowed: 'hunter' };
  const generated = grandchildren.map((part, i) => {
    const spec = { ...left, ...part, ports: [...inherited[part.id], i ? pairedBoundaryPort(inner) : inner] };
    const artifact = generateMicroRegion(spec);
    return { ...spec, blockers: artifact.elements.flatMap(e => elementShapes(e)) };
  });
  assert.deepEqual(validateBoundaryComposition(left, generated).errors, []);
  children[0] = { ...left, blockers: generated.flatMap(child => child.blockers) };
  assert.deepEqual(validateBoundaryComposition(parent, children).errors, [], 'parent contract survives nested implementation');
});

test('post-generation validation rejects broken interiors and missing inherited or paired contracts', () => {
  const { parent, children } = example();
  children[0].blockers.push(rect(4 * 40, 0, 8, 400));
  const blocked = validateBoundaryComposition(parent, children);
  assert.equal(blocked.valid, false);
  assert.ok(blocked.errors.some(e => e.startsWith('left:')));
  assert.ok(blocked.errors.some(e => e.startsWith('parent:')));
  const missing = example(); missing.children[0].ports.shift();
  assert.ok(validateBoundaryComposition(missing.parent, missing.children).errors.some(e => /inherited/.test(e)));
  const mismatched = example(); mismatched.children[1].ports[1].required = 'contestant';
  assert.ok(validateBoundaryComposition(mismatched.parent, mismatched.children).errors.some(e => /neighbor contract/.test(e)));
});

test('inheritance refuses to silently split a crossing or lose parent cells', () => {
  const { parent, children } = example();
  parent.ports = [{ id: 'north', side: 'N', start: { x: 7, y: 0 }, length: 3, required: 'hunter', allowed: 'hunter' }];
  assert.throws(() => inheritBoundaryPorts(parent, children), /spans children/);
  parent.ports = []; children[0].cells.pop();
  assert.throws(() => inheritBoundaryPorts(parent, children), /partition/);
});
