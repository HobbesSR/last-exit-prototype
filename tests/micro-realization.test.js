import test from 'node:test';
import assert from 'node:assert/strict';
import { planExample, decompositionExample } from '../shared/map/micro/decomposition/example.ts';
import { realizeDecomposition, validateRealization } from '../shared/map/micro/decomposition/realize.ts';
import { realizationCollisionMap } from '../shared/map/micro/decomposition/preview.ts';
import { microMetrics } from '../shared/map/micro/metrics.ts';
import { moveBody, canOccupy } from '../shared/movement.ts';
import { rect } from '../shared/shape.ts';

test('decomposition feeds independent micro builders with paired passages and populated rooms', () => {
  const plan = planExample(decompositionExample('neck')), before = structuredClone(plan);
  const result = realizeDecomposition(plan);
  assert.deepEqual(plan, before);
  assert.deepEqual(result, realizeDecomposition(plan));
  assert.equal(result.regions.length, 3);
  assert.equal(result.portals.length, 2);
  assert.equal(result.routes.length, 4);
  for (const assignment of result.assignments.filter(a => a.role === 'room')) {
    const region = result.regions.find(r => r.spec.id === assignment.pieceId);
    assert.ok(region.manifest.structures > 0, 'room allocation receives actual roofed assemblies');
    assert.ok(region.manifest.gates > 0);
  }
  assert.ok(result.portals.every(p => p.width === 80));
  assert.deepEqual(validateRealization(result), []);
  const varied = realizeDecomposition(plan, { seed: 77, roomBuilder: 'ruins' });
  assert.deepEqual(varied.plan, result.plan, 'content controls do not secretly redecompose ownership');
  assert.notDeepEqual(varied.regions.map(r => r.elements), result.regions.map(r => r.elements));
  const external = decompositionExample('neck');
  external.entrances = [{ id: 'macro-entry', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }], requiredWidth: 2 }];
  assert.throws(() => realizeDecomposition(planExample(external)), /External macro entrances/);
});

test('both real collision bodies can traverse every saved inter-region route', () => {
  const result = realizeDecomposition(planExample(decompositionExample('neck')));
  const { map, origin } = realizationCollisionMap(result);
  for (const gate of map.gates) gate.open = true; // Static route contract assumes unlocked doors can be opened.
  for (const route of result.routes) {
    const walker = { x: origin.x + route.points[0].x, y: origin.y + route.points[0].y };
    const radius = microMetrics(result.regions[0].spec).body[route.role];
    for (const target of route.points.slice(1)) {
      let remaining = 1000;
      while (Math.hypot(origin.x + target.x - walker.x, origin.y + target.y - walker.y) > .01 && remaining-- > 0) {
        const dx = origin.x + target.x - walker.x, dy = origin.y + target.y - walker.y, length = Math.hypot(dx, dy);
        moveBody(map, walker, { x: dx / length, y: dy / length }, radius, Math.min(8, length));
        assert.ok(canOccupy(map, walker.x, walker.y, radius));
      }
      assert.ok(remaining > 0, `physical ${route.role} movement reached ${route.to}`);
    }
  }
});

test('realization is valid over example shapes and content seeds, with void collision around holes', () => {
  for (const shape of ['neck', 'l', 'ring', 'rectangle']) for (const seed of [1, 42, 777]) {
    const result = realizeDecomposition(planExample(decompositionExample(shape)), { seed });
    assert.deepEqual(validateRealization(result), [], `${shape}/${seed}`);
    if (shape === 'ring') {
      const { map, origin } = realizationCollisionMap(result);
      assert.equal(canOccupy(map, origin.x + 10 * 40, origin.y + 7 * 40, 25), false, 'hole is outside playable ground');
    }
  }
});

test('realization validator rejects altered ownership, blocked passages, forged endpoints and omitted portals', () => {
  const original = realizeDecomposition(planExample(decompositionExample('neck')));
  const missing = structuredClone(original); missing.portals.pop();
  assert.ok(validateRealization(missing).some(e => /portal coverage/.test(e)));
  const endpoint = structuredClone(original); endpoint.routes[0].points = [endpoint.routes[0].points[0], endpoint.routes[0].points[0]];
  assert.ok(validateRealization(endpoint).some(e => /endpoints/.test(e)));
  const ownership = structuredClone(original); ownership.regions[0].spec.cells.pop();
  assert.ok(validateRealization(ownership).length > 0);
  const assignment = structuredClone(original);
  assignment.assignments[0].generator = 'invented-generator';
  assert.ok(validateRealization(assignment).some(e => /assignment/.test(e)));
  const blocked = structuredClone(original), region = blocked.regions.find(r => r.spec.builder === 'entry');
  region.elements.push({ label: 'block-junction', x: 0, y: 0, template: { w: 8, h: 120, parts: [{ part: 'obstacle', shape: rect(400, 200, 8, 120), kind: 'ruin-wall' }] } });
  assert.ok(validateRealization(blocked).some(e => /blocked|obstructed|floor/.test(e)));
  assert.throws(() => realizationCollisionMap(blocked), /invalid realization/);
});
