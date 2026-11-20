import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, inspect } from '../tools/physics/metrics.mjs';

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
