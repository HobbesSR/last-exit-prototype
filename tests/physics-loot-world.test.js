import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsWorld } from '../shared/physics/world.ts';

const loot = (id, x, options = {}) => ({ id, kind: 'prop', collisionProfile: 'loot',
  shape: { kind: 'circle', radius: 4 }, x, y: 0, mass: 1, friction: 0,
  restitution: 0, ...options });
const circle = (id, kind, x) => ({ id, kind, shape: { kind: 'circle', radius: 7 },
  x, y: 0, friction: 0, restitution: 0 });

test('loot passes actors, props, and loot but stops at a thin static wall', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('actor', 'actor', -30));
    world.queueAddBody(circle('prop', 'prop', -5));
    world.queueAddBody(loot('other', 20));
    world.queueAddBody({ id: 'wall', kind: 'static', shape: { kind: 'box', hx: 1, hy: 30 }, x: 65, y: 0 });
    world.queueAddBody(loot('moving', -60, { vx: 200 }));
    world.commitMutations();
    for (let i = 0; i < 12; i++) world.step();
    const x = world.getTransform('moving').x;
    assert.ok(x > 55 && x <= 60.1, `loot stops at wall: ${x}`);
    assert.ok(Math.abs(world.getTransform('actor').x + 30) < 0.01);
    assert.ok(Math.abs(world.getTransform('prop').x + 5) < 0.01);
    assert.ok(Math.abs(world.getTransform('other').x - 20) < 0.01);
    const contacts = world.drainContacts();
    assert.ok(contacts.some(event => event.a === 'moving' && event.b === 'wall' && event.type === 'start'));
    assert.ok(contacts.every(event => event.a !== 'moving' || event.b === 'wall'));
    assert.equal(world.overlapsDynamicBox({ x: 56, y: -5, w: 9, h: 10 }), false);
  } finally { world.dispose(); }
});

test('loot damping is validated, stored in snapshots, and sleeping loot wakes on impulse', async () => {
  const world = await createPhysicsWorld();
  try {
    for (const value of [-1, Infinity, NaN]) {
      assert.throws(() => world.queueAddBody(loot(`bad-linear-${value}`, 0, { linearDamping: value })));
      assert.throws(() => world.queueAddBody(loot(`bad-angular-${value}`, 0, { angularDamping: value })));
    }
    assert.throws(() => world.queueAddBody({ ...loot('bad-kind', 0), kind: 'actor' }), /collision profile/);
    assert.deepEqual(world.snapshot().pending.add, []);
    world.queueAddBody(loot('damped', 0, { vx: 100, linearDamping: 16, angularDamping: 4 }));
    world.commitMutations();
    const spec = world.snapshot().bodies[0].spec;
    assert.equal(spec.collisionProfile, 'loot');
    assert.equal(spec.linearDamping, 16);
    assert.equal(spec.angularDamping, 4);
    for (let i = 0; i < 300 && !world.getTransform('damped').sleeping; i++) world.step();
    assert.equal(world.getTransform('damped').sleeping, true);
    world.setDamping('damped', 8, 2);
    assert.equal(world.getTransform('damped').sleeping, true);
    assert.equal(world.snapshot().bodies[0].spec.linearDamping, 8);
    assert.equal(world.snapshot().bodies[0].spec.angularDamping, 2);
    assert.throws(() => world.setDamping('damped', 5, -1), /nonnegative/);
    assert.equal(world.snapshot().bodies[0].spec.linearDamping, 8);
    world.queueImpulse('damped', { x: 100, y: 0 });
    world.step();
    assert.equal(world.getTransform('damped').sleeping, false);
    assert.ok(world.getTransform('damped').vx > 0);
  } finally { world.dispose(); }
});

test('loot removal clears attached joints and dynamic capacity preflight includes queued actors and props', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(loot('item', 0));
    world.queueAddBody(circle('anchor', 'prop', 20));
    world.queueAddConstraint({ id: 'rope', a: 'item', b: 'anchor', maxDistance: 30 });
    world.commitMutations();
    assert.equal(world.counts().constraints, 1);
    world.queueRemoveBody('item');
    world.commitMutations();
    assert.equal(world.hasBody('item'), false);
    assert.equal(world.counts().constraints, 0);
    assert.deepEqual(world.snapshot().constraints, []);
    assert.equal(world.canAddBodies(127), true);
    assert.equal(world.canAddBodies(128), false);
    world.queueAddBody(circle('actor', 'actor', 50));
    assert.equal(world.canAddBodies(126), true);
    assert.equal(world.canAddBodies(127), false);
    world.queueRemoveBody('anchor');
    assert.equal(world.canAddBodies(127), true);
    assert.throws(() => world.canAddBodies(-1), /nonnegative integer/);
    assert.throws(() => world.canAddBodies(1.5), /nonnegative integer/);
  } finally { world.dispose(); }
});
