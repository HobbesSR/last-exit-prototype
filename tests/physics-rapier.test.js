import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld } from '../tools/physics/rapier.mjs';

test('spring force is applied for one substep, then cleared', async () => {
  const world = await createWorld({
    bodies: [
      { id: 'anchor', kind: 'static', x: 0, y: 0 },
      { id: 'body', kind: 'prop', x: 30, y: 0, radius: 1, mass: 1 },
    ],
    joints: [{ id: 'spring', kind: 'spring', a: 'anchor', b: 'body', length: 20, stiffness: 10, damping: 0 }],
  });
  try {
    world.step(0.01);
    const first = world.states().find(body => body.id === 'body');
    assert.ok(Math.abs(first.vx + 1) < 1e-4, `expected -1 world unit/s, got ${first.vx}`);
    world.removeJoint('spring');
    world.step(0.01);
    const second = world.states().find(body => body.id === 'body');
    assert.ok(Math.abs(second.vx - first.vx) < 1e-4, 'removed spring left a persistent force');
  } finally { world.dispose(); }
});

test('rope arrests separation when force permits and reports stretch at saturation', async () => {
  const scene = maxForce => ({
    bodies: [
      { id: 'a', kind: 'prop', x: 0, y: 0, radius: 1, vx: -100 },
      { id: 'b', kind: 'prop', x: 30, y: 0, radius: 1, vx: 100 },
    ],
    joints: [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 30, maxForce }],
  });
  const strong = await createWorld(scene(10000));
  const weak = await createWorld(scene(10));
  try {
    strong.step(0.0125);
    weak.step(0.0125);
    const separation = world => {
      const [a, b] = world.states();
      return b.x - a.x;
    };
    assert.ok(separation(strong) <= 30.01);
    assert.ok(separation(weak) > 31, 'force saturation should remain observable');
  } finally { strong.dispose(); weak.dispose(); }
});

test('cast handles first step, broad phase, deletion and snapshot restore', async () => {
  const world = await createWorld({
    bodies: [
      { id: 'a', kind: 'prop', x: 30, y: 0, radius: 5 },
      { id: 'b', kind: 'prop', x: 30, y: 0, radius: 5 },
      { id: 'loot', kind: 'loot', x: 15, y: 0, radius: 5 },
    ], joints: [],
  });
  const cast = () => world.cast({ x: 0, y: 0, dx: 60, dy: 0, radius: 0 });
  try {
    assert.equal(cast()?.id, 'a');
    world.step(0.0125);
    assert.equal(cast()?.id, 'a');
    const checkpoint = world.checkpoint();
    world.removeBody('a');
    assert.equal(cast()?.id, 'b');
    world.restore(checkpoint);
    assert.equal(cast()?.id, 'a');
  } finally { world.dispose(); }
});
