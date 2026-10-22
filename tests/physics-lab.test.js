import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, createMetrics } from '../tools/physics/metrics.mjs';
import { loadCandidate, correctness, lifecycle } from '../tools/physics/runner.mjs';

const circle = (id, x, y, extra = {}) =>
  ({ id, kind: 'actor', shape: 'circle', radius: 1, x, y, ...extra });
const staticCircle = (id, x, y, extra = {}) =>
  ({ id, kind: 'static', shape: 'circle', radius: 1, x, y, ...extra });
const approx = (actual, expected, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ${actual} within ${tolerance} of ${expected}`);

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

for (const candidate of ['custom', 'rapier']) {
  test(`${candidate}: cast chooses earliest solid hit and respects exclusions`, async () => {
    const create = await loadCandidate(candidate);
    const world = await create({ bodies: [staticCircle('near', 5, 0),
      staticCircle('far', 10, 0), { ...staticCircle('loot', 2, 0), kind: 'loot' }], joints: [] });
    try {
      const query = { x: 0, y: 0, dx: 20, dy: 0, radius: 0.5 };
      const first = world.cast(query);
      assert.equal(first?.id, 'near');
      approx(first.toi, 3.5 / 20, 0.002);
      const second = world.cast({ ...query, exclude: 'near' });
      assert.equal(second?.id, 'far');
      approx(second.toi, 8.5 / 20, 0.002);
      assert.equal(world.cast({ x: 0, y: 10, dx: 20, dy: 0, radius: 0.5 }), null);
    } finally { world.dispose(); }
  });

  test(`${candidate}: invalid finite input is rejected`, async () => {
    const create = await loadCandidate(candidate);
    await assert.rejects(async () => create({
      bodies: [circle('bad', Infinity, 0)], joints: [],
    }));
    await assert.rejects(async () => create({
      bodies: [circle('bad', 0, 0, { mass: 0 })], joints: [],
    }));
    const world = await create({ bodies: [circle('a', 0, 0)], joints: [] });
    try {
      assert.throws(() => world.step(NaN));
      assert.throws(() => world.impulse('a', { x: Infinity, y: 0 }));
      assert.throws(() => world.cast({ x: 0, y: 0, dx: NaN, dy: 0, radius: 1 }));
    } finally { world.dispose(); }
  });

  test(`${candidate}: removal clears joints before ID reuse and disposal clears handles`, async () => {
    const create = await loadCandidate(candidate);
    const world = await create({ bodies: [circle('a', 0, 0), circle('b', 10, 0)],
      joints: [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 10 }] });
    assert.deepEqual(world.counts(), { bodies: 2, joints: 1 });
    assert.equal(world.removeBody('b'), true);
    assert.deepEqual(world.counts(), { bodies: 1, joints: 0 });
    world.addBody(circle('b', 20, 0));
    world.step(0.0125);
    assert.deepEqual(world.counts(), { bodies: 2, joints: 0 });
    world.dispose(); world.dispose();
    assert.deepEqual(world.counts(), { bodies: 0, joints: 0 });
    assert.throws(() => world.states());
  });

  test(`${candidate}: checkpoint restores motor and exact continuation`, async () => {
    const create = await loadCandidate(candidate);
    const world = await create({ bodies: [circle('a', 0, 0,
      { mass: 2, motor: { x: 6, y: 1, accel: 12 } })], joints: [] });
    try {
      world.step(0.0125);
      const checkpoint = world.checkpoint();
      const motor = world.states()[0].motor;
      world.step(0.0125);
      const expected = world.states()[0];
      world.motor('a', { x: -20, y: 3, accel: 100 });
      world.step(0.0125);
      world.restore(checkpoint);
      assert.deepEqual(world.states()[0].motor, motor);
      world.step(0.0125);
      const actual = world.states()[0];
      for (const field of ['x', 'y', 'vx', 'vy', 'angle', 'omega'])
        approx(actual[field], expected[field], 1e-5);
    } finally { world.dispose(); }
  });

  test(`${candidate}: bounded motor recovery preserves an external impulse`, async () => {
    const create = await loadCandidate(candidate);
    const world = await create({ bodies: [circle('a', 0, 0,
      { mass: 2, motor: { x: 0, y: 0, accel: 10 } })], joints: [] });
    try {
      world.impulse('a', { x: 20, y: 0 });
      world.step(0.05);
      const speed = world.states()[0].vx;
      assert.ok(speed > 8 && speed < 10, `impulse must remain after one motor step: ${speed}`);
    } finally { world.dispose(); }
  });
}

test('runner records initial overlap separately and checks lifecycle without a full matrix', async () => {
  const rows = await correctness('custom', { substepsList: [2], only: ['coincident-spawn'] });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].initial.actorPenetration > 0);
  assert.equal(typeof rows[0].numericalGate, 'boolean');
  assert.equal(rows[0].checkpoint.restored, true);
  const result = await lifecycle('custom', 2);
  assert.equal(result.zeroCounts, true);
  assert.equal(result.postDisposeThrows, true);
});
