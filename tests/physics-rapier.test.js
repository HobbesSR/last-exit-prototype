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

test('opt-in native spring remains bounded at high stiffness and uses centre anchors', async () => {
  const world = await createWorld({
    bodies: [
      { id: 'anchor', kind: 'static', x: 0, y: 0, radius: 1 },
      { id: 'body', kind: 'prop', x: 30, y: 0, radius: 1, mass: 1 },
    ],
    joints: [{ id: 'spring', kind: 'spring', backend: 'native', a: 'anchor', b: 'body',
      length: 20, stiffness: 100000, damping: 500 }],
  });
  try {
    assert.match(world.settings.joints, /evaluation-only/);
    assert.equal(world.counts().joints, 1);
    for (let i = 0; i < 160; i++) {
      world.step(0.0125);
      const body = world.states().find(state => state.id === 'body');
      assert.ok(Number.isFinite(body.x) && Number.isFinite(body.vx));
      assert.ok(Math.abs(body.x) < 100, `native spring diverged at step ${i}: ${body.x}`);
      assert.ok(Math.abs(body.angle) < 1e-6, 'centre anchors should not produce torque');
    }
    const body = world.states().find(state => state.id === 'body');
    assert.ok(Math.abs(body.x - 20) < 1, `native spring did not settle: ${body.x}`);
  } finally { world.dispose(); }
});

test('native springs reject finite force caps and ropes, while default spring stays game-owned', async () => {
  const bodies = [
    { id: 'a', kind: 'static', x: 0, y: 0, radius: 1 },
    { id: 'b', kind: 'prop', x: 30, y: 0, radius: 1 },
  ];
  const world = await createWorld({ bodies, joints: [] });
  try {
    const base = { id: 'spring', kind: 'spring', a: 'a', b: 'b', length: 20 };
    assert.throws(() => world.addJoint({ ...base, backend: 'native', maxForce: 10000 }), /finite maxForce/);
    assert.throws(() => world.addJoint({ ...base, kind: 'rope', backend: 'native' }), /springs only/);
    assert.deepEqual(world.counts(), { bodies: 2, joints: 0 });
    world.addJoint(base);
    world.step(0.01);
    assert.ok(world.states().find(state => state.id === 'b').vx < 0);
  } finally { world.dispose(); }
});

test('native spring handles survive checkpoint restore and leave no joints on deletion', async () => {
  const world = await createWorld({
    bodies: [
      { id: 'a', kind: 'static', x: 0, y: 0, radius: 1 },
      { id: 'b', kind: 'prop', x: 30, y: 0, radius: 1 },
      { id: 'c', kind: 'prop', x: 60, y: 0, radius: 1 },
    ],
    joints: [
      { id: 'ab', kind: 'spring', backend: 'native', a: 'a', b: 'b', length: 20 },
      { id: 'bc', kind: 'spring', backend: 'native', a: 'b', b: 'c', length: 20 },
    ],
  });
  try {
    const checkpoint = world.checkpoint();
    world.step(0.0125);
    const expected = world.states();
    world.restore(checkpoint);
    world.step(0.0125);
    assert.deepEqual(world.states(), expected, 'native spring did not replay after restore');
    assert.equal(world.removeJoint('ab'), true);
    assert.equal(world.removeJoint('ab'), false);
    world.removeBody('b');
    assert.deepEqual(world.counts(), { bodies: 2, joints: 0 });
    world.restore(checkpoint);
    assert.deepEqual(world.counts(), { bodies: 3, joints: 2 });
    world.step(0.0125);
    assert.equal(world.removeJoint('ab'), true);
    world.removeBody('b');
    assert.deepEqual(world.counts(), { bodies: 2, joints: 0 });
    world.step(0.0125);
  } finally { world.dispose(); }
  assert.deepEqual(world.counts(), { bodies: 0, joints: 0 });
  world.dispose();
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
