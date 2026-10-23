import test from 'node:test';
import assert from 'node:assert/strict';
import { admitMotion, bodySpeedCap, scenarios } from '../tools/physics/scenarios.mjs';
import { correctness } from '../tools/physics/runner.mjs';
import { createMetrics, inspect } from '../tools/physics/metrics.mjs';

test('motion admission bounds size and refuses excess speed before simulation', async () => {
  for (const n of [2, 4, 8]) {
    assert.equal(bodySpeedCap(12, n), 192 * n);
    assert.equal(bodySpeedCap(23, n), bodySpeedCap(12, n));
    const rows = await correctness('rapier', { substepsList: [n], only: ['over-cap-refused-r12', 'over-cap-refused-r23'] });
    for (const row of rows) {
      assert.equal(row.admission.admitted, false);
      assert.equal(row.numericalGate, true);
      assert.equal(row.repeatExact, true);
      assert.equal(row.metrics, undefined); // Refusal has no simulated trajectory.
    }
  }
  assert.equal(admitMotion([{ id: 'bad', kind: 'actor', radius: 12, vx: Infinity }], 4).admitted, false);
  assert.equal(admitMotion([{ id: 'default-radius', kind: 'actor', vx: 512 }], 4).admitted, true);
  assert.equal(admitMotion([{ id: 'default-radius', kind: 'actor', vx: 513 }], 4).admitted, false);
});

test('speculative contacts keep offset capped pairs inside the actor overlap bound', async () => {
  const names = scenarios().filter(s => s.name.startsWith('moving-pair') || s.name.startsWith('game-pair')).map(s => s.name);
  const rows = await correctness('rapier', { only: names });
  for (const row of rows) {
    assert.equal(row.numericalGate, true, `${row.scenario}/${row.substeps}`);
    assert.equal(row.repeatExact, true);
    assert.equal(row.checkpoint.exact, true);
    assert.ok(row.final.find(b => b.id === 'a').x < row.final.find(b => b.id === 'b').x);
  }
});

test('angle wrap uses the short arc while a real rotating sweep is still detected', () => {
  const wall = { id: 'wall', kind: 'static', shape: 'box', x: 0, y: 0, hx: 1, hy: 10 };
  const beam = { id: 'beam', kind: 'prop', shape: 'box', x: -6, y: 0, hx: 4, hy: 0.2, angle: Math.PI - 0.05 };
  const scene = { bodies: [wall, beam], joints: [] };
  assert.equal(inspect([wall, { ...beam, angle: -Math.PI + 0.05 }], [wall, beam], scene).crossings, 0);
  const rotating = { ...beam, x: -4, angle: -Math.PI / 3 };
  assert.equal(inspect([wall, { ...rotating, angle: Math.PI / 3 }], [wall, rotating], scene).crossings, 1);
});

test('static recovery tracks each pair and resets only when it recovers', () => {
  const wall = { id: 'wall', kind: 'static', shape: 'box', x: 0, y: 0, hx: 1, hy: 10 };
  const actor = { id: 'a', kind: 'actor', shape: 'circle', radius: 1, x: -1.8, y: 0 };
  const scene = { bodies: [wall, actor], joints: [] }, m = createMetrics(scene);
  for (let i = 0; i < 4; i++) m.inspect([wall, actor]);
  m.inspect([wall, { ...actor, x: -2 }]);
  m.inspect([wall, actor]);
  assert.equal(m.summary().staticRecoverySamples, 4);
  assert.equal(m.summary().staticUnrecoveredPairs, 1);
  m.inspect([wall, { ...actor, x: -2 }]);
  assert.equal(m.summary().staticUnrecoveredPairs, 0);
});

test('revised springs settle; contact and far-coordinate witnesses start legally', async () => {
  const rows = await correctness('rapier', { only: ['spring-decay', 'native-spring-stiff-2000', 'native-spring-stiff-20000', 'dense-doorway-queue', 'distant-coordinates'] });
  for (const row of rows) {
    assert.equal(row.numericalGate, true, `${row.scenario}/${row.substeps}`);
    assert.equal(row.initial.staticPenetration, 0);
    assert.equal(row.initial.actorPenetration, 0);
    assert.equal(row.repeatExact, true);
    assert.equal(row.checkpoint.exact, true);
  }
});
