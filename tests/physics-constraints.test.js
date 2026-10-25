import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsWorld } from '../shared/physics/world.ts';

const body = (id, x, options = {}) => ({ id, kind: 'prop', shape: { kind: 'circle', radius: 2 },
  x, y: 0, friction: 0, ...options });
const rope = (options = {}) => ({ id: 't', a: 'a', b: 'b', kind: 'rope', maxDistance: 10,
  stiffness: 2000, damping: 0, maxForce: 200, ...options });

test('explicit constraint validates a finite cap atomically and preserves legacy native rope', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(body('a', 0)); world.queueAddBody(body('b', 20));
    assert.throws(() => world.queueAddConstraint(rope({ maxForce: undefined })), /maxForce|finite/);
    assert.throws(() => world.queueAddConstraint(rope({ maxForce: Infinity })), /finite/);
    assert.throws(() => world.queueAddConstraint({ ...rope(), kind: undefined }), /explicit kind/);
    assert.deepEqual(world.snapshot().pending.addConstraints, []);
    world.queueAddConstraint({ id: 'old', a: 'a', b: 'b', maxDistance: 30 });
    world.commitMutations();
    assert.deepEqual(world.snapshot().constraints, [{ id: 'old', a: 'a', b: 'b', maxDistance: 30 }]);
    assert.equal(world.hasConstraint('old'), true);
  } finally { world.dispose(); }
});

test('bounded rope pulls unequal masses with equal opposite force and stays slack within range', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(body('a', 0, { mass: 1 })); world.queueAddBody(body('b', 30, { mass: 4 }));
    world.queueAddConstraint(rope()); world.step();
    const a = world.getTransform('a'), b = world.getTransform('b');
    assert.ok(a.vx > 0 && b.vx < 0);
    assert.ok(Math.abs(a.vx + b.vx * 4) < 0.05, `${a.vx}, ${b.vx}`);
    assert.ok(a.vx <= 10.01, '200 force units for 0.05 s on unit mass');
    assert.ok(b.x - a.x > 10, 'finite force does not project length');
    world.queueRemoveConstraint('t'); world.commitMutations();
    assert.equal(world.hasConstraint('t'), false);
    world.setTransform('a', { x: 0, y: 0, angle: 0 });
    world.setTransform('b', { x: 8, y: 0, angle: 0 });
    world.queueAddConstraint(rope()); world.step();
    assert.ok(Math.abs(world.getTransform('a').vx) < 0.001);
    assert.ok(Math.abs(world.getTransform('b').vx) < 0.001);
  } finally { world.dispose(); }
});

test('bounded constraints solve in ID order independent of queue order', async () => {
  const worlds = [await createPhysicsWorld(), await createPhysicsWorld()];
  try {
    const bodies = [body('a', 0), body('b', 30), body('c', 60)];
    const constraints = [rope({ id: 'z', a: 'a', b: 'b' }),
      rope({ id: 'x', a: 'b', b: 'c' })];
    for (const item of bodies) worlds[0].queueAddBody(item);
    for (const item of bodies.toReversed()) worlds[1].queueAddBody(item);
    for (const item of constraints) worlds[0].queueAddConstraint(item);
    for (const item of constraints.toReversed()) worlds[1].queueAddConstraint(item);
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(worlds[0].step(), worlds[1].step());
      assert.deepEqual(worlds[0].snapshot(), worlds[1].snapshot());
    }
  } finally { for (const world of worlds) world.dispose(); }
});

test('spring handles zero length and local anchors create torque', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(body('a', 0)); world.queueAddBody(body('b', 0));
    world.queueAddConstraint({ ...rope(), kind: 'spring', restLength: 0 });
    world.step();
    for (const id of ['a', 'b']) assert.ok(Number.isFinite(world.getTransform(id).vx));
    world.queueRemoveConstraint('t'); world.commitMutations();
    world.setTransform('b', { x: 30, y: 0, angle: 0 });
    world.queueAddConstraint({ ...rope(), kind: 'spring', restLength: 10,
      anchorA: { x: 0, y: 2 }, anchorB: { x: 0, y: 0 } });
    world.step();
    assert.ok(Math.abs(world.getTransform('a').omega) > 0.001);
    assert.ok(Math.abs(world.getTransform('b').omega) < 0.001);
  } finally { world.dispose(); }
});

test('break distance, endpoint deletion, and teleport clear explicit constraints', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(body('a', 0)); world.queueAddBody(body('b', 30));
    world.queueAddConstraint(rope({ breakDistance: 20 })); world.step();
    assert.equal(world.hasConstraint('t'), false);
    world.queueAddConstraint(rope()); world.commitMutations();
    world.setTransform('a', { x: 0, y: 0, angle: 0 });
    assert.equal(world.hasConstraint('t'), false);
    world.queueAddConstraint(rope()); world.commitMutations();
    world.queueRemoveBody('a'); world.commitMutations();
    assert.equal(world.hasConstraint('t'), false);
  } finally { world.dispose(); }
});

test('bounded rope yields to a wall and wakes sleeping endpoints when attached', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(body('a', -20)); world.queueAddBody(body('b', 20));
    world.queueAddBody({ id: 'wall', kind: 'static', shape: { kind: 'box', hx: 2, hy: 40 }, x: 0, y: 0 });
    for (let i = 0; i < 100; i++) world.step();
    world.queueAddConstraint(rope({ maxDistance: 4, maxForce: 100 })); world.commitMutations();
    assert.equal(world.getTransform('a').sleeping, false);
    assert.equal(world.getTransform('b').sleeping, false);
    for (let i = 0; i < 20; i++) world.step();
    const a = world.getTransform('a'), b = world.getTransform('b');
    assert.ok(a.x < -3 && b.x > 3, `${a.x}, ${b.x}`);
    assert.ok(b.x - a.x > 4);
    assert.ok(Number.isFinite(a.vx) && Number.isFinite(b.vx));
  } finally { world.dispose(); }
});
