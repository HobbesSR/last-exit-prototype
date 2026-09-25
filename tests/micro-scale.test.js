import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMicroRegion, validateMicroRegion } from '../shared/map/micro/index.ts';
import { microExample } from '../shared/map/micro/examples.ts';
import { microMetrics } from '../shared/map/micro/sdk.ts';
import { regionCollisionMap } from '../shared/map/micro/adapter.ts';
import { canOccupy, moveBody } from '../shared/movement.ts';

test('cell proportions use real collision bodies through 1.5-cell squeezes and 2-cell doors', () => {
  const spec = { ...microExample('entry'), bodyProfile: 'cell' };
  spec.ports.push({ id: 'squeeze', side: 'N', start: { x: 10, y: 0 }, length: 2, required: 'contestant', allowed: 'contestant' });
  const result = generateMicroRegion(spec), metrics = microMetrics(spec), map = regionCollisionMap(result);
  assert.equal(metrics.body.contestant * 2 / spec.cellSize, 1.25);
  assert.equal(metrics.body.hunter * 2 / spec.cellSize, 1.75);
  for (const port of result.ports) {
    assert.equal(port.width / spec.cellSize, port.id === 'squeeze' ? 1.5 : 2);
    const p = { x: 12000 + port.centre.x, y: 6000 + port.centre.y };
    assert.ok(canOccupy(map, p.x, p.y, metrics.body.contestant));
    assert.equal(canOccupy(map, p.x, p.y, metrics.body.hunter), port.id !== 'squeeze');
  }
  const squeeze = result.ports.at(-1);
  for (const role of ['contestant', 'hunter']) {
    const walker = { x: 12000 + squeeze.centre.x, y: 6000 + squeeze.inside.y };
    for (let i = 0; i < 20; i++) moveBody(map, walker, { y: -1 }, metrics.body[role], 8);
    assert.equal(walker.y < 6000, role === 'contestant');
  }
});

test('entry areas spread 24 candidates over irregular masks and detect edited artifacts', () => {
  for (const shape of ['rectangle', 'l', 'hole']) {
    const spec = { ...microExample('entry', 7, shape), bodyProfile: 'cell' };
    const result = generateMicroRegion(spec);
    assert.equal(result.entry.points.length, 24);
    assert.equal(result.entry.shortfall, 0);
    assert.ok(result.entry.minimumSpacing >= microMetrics(spec).clearance.contestant * 2);
    assert.deepEqual(validateMicroRegion(result), []);
    result.entry.points[0].x = -100;
    assert.ok(validateMicroRegion(result).some(error => /Entry placement/.test(error)));
  }
});

test('entry seeds change the selected positions while keeping the same placement contract', () => {
  const one = { ...microExample('entry', 7, 'rectangle'), bodyProfile: 'cell' };
  const two = { ...one, seed: 8 };
  const first = generateMicroRegion(one), varied = generateMicroRegion(two);
  assert.notDeepEqual(varied.entry.points, first.entry.points, 'entry seed must affect emitted point geometry');
  for (const result of [first, varied]) {
    assert.equal(result.entry.shortfall, 0);
    assert.ok(result.entry.minimumSpacing >= microMetrics(result.spec).clearance.contestant * 2);
    assert.deepEqual(validateMicroRegion(result), []);
  }
});

test('example builders honor cell-profile routes across shapes and seeds', () => {
  for (const builder of ['open', 'depot', 'courtyard', 'ruins']) for (const shape of ['rectangle', 'l', 'hole']) for (const seed of [1, 42, 9961]) {
    const spec = { ...microExample(builder, seed, shape), bodyProfile: 'cell' };
    const result = generateMicroRegion(spec);
    assert.deepEqual(validateMicroRegion(result), []);
    assert.ok(result.manifest.attempted > result.manifest.rejected);
    for (const gate of result.elements.flatMap(e => e.template.parts).filter(p => p.part === 'gate')) assert.equal(gate.w, 2 * spec.cellSize);
  }
});
