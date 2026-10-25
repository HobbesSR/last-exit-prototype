import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsWorld } from '../shared/physics/world.ts';

test('developer contacts expose detached world-unit normals without changing gameplay capture', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody({ id: 'a', kind: 'actor', shape: { kind: 'circle', radius: 12 }, x: 100, y: 100 });
    world.queueAddBody({ id: 'b', kind: 'static', shape: { kind: 'box', hx: 10, hy: 30 }, x: 122, y: 100 });
    world.commitMutations();
    world.setMotor('a', { x: 100, y: 0, accel: 500 });
    world.step();
    const before = world.snapshot();
    const contacts = world.debugContacts();
    assert.ok(contacts.length > 0 && contacts.length <= 256);
    for (const contact of contacts) {
      assert.equal(contact.a, 'a'); assert.equal(contact.b, 'b');
      assert.ok(Math.abs(Math.hypot(contact.normal.x, contact.normal.y) - 1) < 1e-5);
      assert.ok(contact.normal.x > .9, 'normal points from the actor toward the wall');
      assert.ok(contact.point.x > 105 && contact.point.x < 120, 'point uses world units');
      assert.ok(Number.isFinite(contact.distance));
    }
    contacts[0].point.x = -1;
    assert.deepEqual(world.snapshot(), before);
    assert.ok(world.debugContacts()[0].point.x > 105);
  } finally { world.dispose(); }
  assert.throws(() => world.debugContacts(), /disposed/);
});

test('developer force arrows use actual final-substep external force in world units', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody({ id: 'p', kind: 'prop', shape: { kind: 'circle', radius: 12 }, x: 100, y: 100 });
    world.commitMutations(); world.queueForce('p', { x: 2000, y: 0 }); world.step();
    const before = world.snapshot(), force = world.debugForces()[0];
    assert.equal(force.id, 'p'); assert.ok(Math.abs(force.force.x - 2000) < .01);
    assert.equal(force.force.y, 0); assert.ok(force.point.x > 100);
    force.force.x = -1;
    assert.deepEqual(world.snapshot(), before);
    assert.ok(world.debugForces()[0].force.x > 1999);
  } finally { world.dispose(); }
  assert.throws(() => world.debugForces(), /disposed/);
});
