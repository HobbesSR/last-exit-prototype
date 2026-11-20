import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, createMetrics } from '../tools/physics/metrics.mjs';

const circle = (id, x, y, extra = {}) =>
  ({ id, kind: 'actor', shape: 'circle', radius: 1, x, y, ...extra });

test('metrics catch a complete thin-wall crossing despite legal endpoints', () => {
  const wall = { id: 'wall', kind: 'static', shape: 'box', x: 0, y: 0, hx: 0.1, hy: 10 };
  const actor = circle('a', -5, 0);
  const scene = { bodies: [wall, actor], joints: [] };
  const previous = [wall, actor];
  const current = [wall, { ...actor, x: 5 }];
  const metrics = createMetrics(scene);
  metrics.inspect(previous, previous);
  const result = metrics.inspect(current, previous);
  assert.equal(result.staticPenetration, 0);
  assert.equal(result.crossings, 1);
  assert.equal(result.details.find(d => d.type === 'crossing')?.method, 'sampled-obb-path');
  assert.equal(metrics.summary().initial.staticPenetration, 0);
  assert.equal(metrics.summary().crossings, 1);
});

test('metrics use relative actor paths and do not flag a separated glance', () => {
  const a = circle('a', -5, 0), b = circle('b', 5, 0);
  const scene = { bodies: [a, b], joints: [] };
  const crossing = inspect([{ ...a, x: 5 }, { ...b, x: -5 }], [a, b], scene);
  assert.equal(crossing.actorPenetration, 0);
  assert.equal(crossing.crossings, 1);
  assert.equal(crossing.details.find(d => d.type === 'crossing')?.method, 'analytic-relative-circle');
  const glance = inspect([{ ...a, x: 5 }, { ...b, x: -5, y: 2.1 }],
    [{ ...a, y: 0 }, { ...b, y: 2.1 }], scene);
  assert.equal(glance.crossings, 0);
  assert.equal(glance.actorPenetration, 0);
});

test('metrics expose nonfinite state and separate invalid initial placement', () => {
  const a = circle('a', 0, 0), b = circle('b', 0, 0);
  const scene = { bodies: [a, b], joints: [] };
  const metrics = createMetrics(scene);
  metrics.inspect([a, b], [a, b]);
  const later = metrics.inspect([{ ...a, x: NaN }, b], [a, b]);
  assert.equal(later.finite, false);
  assert.deepEqual(later.details, [{ type: 'nonfinite', id: 'a' }]);
  assert.ok(metrics.summary().initial.actorPenetration > 0);
});
