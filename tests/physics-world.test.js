import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsWorld } from '../shared/physics/world.ts';

const circle = (id, options = {}) => ({ id, kind: 'prop', shape: { kind: 'circle', radius: 12 },
  x: 0, y: 0, ...options });

test('worlds are independent and mutation admission is atomic', async () => {
  const a = await createPhysicsWorld(), b = await createPhysicsWorld();
  try {
    a.queueAddBody(circle('same'));
    b.queueAddBody(circle('same', { x: 100 }));
    assert.throws(() => a.queueAddBody(circle('same')), /duplicate/);
    assert.throws(() => a.queueAddBody(circle('bad', { x: Infinity })), /finite/);
    a.commitMutations(); b.commitMutations();
    assert.equal(a.getTransform('same').x, 0);
    assert.equal(b.getTransform('same').x, 100);
    assert.equal(a.counts().dynamic, 1);
    a.queueRemoveBody('same');
    a.queueAddBody(circle('same', { x: 20 }));
    a.commitMutations();
    assert.equal(a.getTransform('same').x, 20);
    assert.equal(b.getTransform('same').x, 100);
  } finally { a.dispose(); b.dispose(); }
});

test('forces repeat each substep, impulses occur once, motion is capped, and paths include four steps', async () => {
  const impulse = await createPhysicsWorld(), force = await createPhysicsWorld();
  try {
    for (const world of [impulse, force]) { world.queueAddBody(circle('p')); world.commitMutations(); }
    impulse.queueImpulse('p', { x: 100, y: 0 });
    force.queueForce('p', { x: 2000, y: 0 });
    const one = impulse.step(), continuous = force.step();
    assert.equal(one.paths.p.length, 5);
    assert.equal(continuous.paths.p.length, 5);
    assert.ok(one.distance.p > 0 && continuous.distance.p > 0);
    assert.ok(Math.abs(impulse.getTransform('p').vx - 100) < 0.01);
    assert.ok(Math.abs(force.getTransform('p').vx - 100) < 0.01);
    assert.ok(Math.abs(impulse.step().distance.p - 5) < 0.01);
    const cap = await createPhysicsWorld();
    try {
      cap.queueAddBody(circle('fast'));
      cap.commitMutations();
      cap.queueImpulse('fast', { x: 100000, y: 0 });
      cap.step();
      assert.ok(cap.getTransform('fast').vx <= 768.001);
    } finally { cap.dispose(); }
  } finally { impulse.dispose(); force.dispose(); }
});

test('canonical contacts, engine-free pending snapshot, and disposal guards', async () => {
  const world = await createPhysicsWorld();
  world.queueAddBody(circle('z', { x: -20, vx: 100 }));
  world.queueAddBody(circle('a', { x: 20, vx: -100 }));
  world.queueAddBody({ id: 'wall', kind: 'static', shape: { kind: 'box', hx: 2, hy: 50 }, x: 100, y: 0 });
  world.commitMutations();
  world.setMotor('z', { x: 0, y: 0, accel: 500 });
  world.queueForce('a', { x: 1, y: 0 });
  world.queueAddBody(circle('later', { x: 300 }));
  const snap = world.snapshot();
  assert.equal(snap.pending.add[0].id, 'later');
  assert.equal(snap.pending.forces[0].id, 'a');
  assert.deepEqual(snap.bodies.find(body => body.spec.id === 'z').motor, { x: 0, y: 0, accel: 500 });
  assert.equal(JSON.stringify(snap).includes('handle'), false);
  world.step();
  for (const event of world.drainContacts()) assert.ok(event.a < event.b);
  assert.deepEqual(world.drainContacts(), []);
  world.dispose(); world.dispose();
  assert.throws(() => world.counts(), /disposed/);
  assert.throws(() => world.snapshot(), /disposed/);
});

test('native rope uses stable IDs and removing an endpoint removes the rope', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('a', { x: -10 }));
    world.queueAddBody(circle('b', { x: 10 }));
    world.queueAddConstraint({ id: 'rope', a: 'a', b: 'b', maxDistance: 30 });
    world.commitMutations();
    assert.equal(world.counts().constraints, 1);
    assert.deepEqual(world.snapshot().constraints, [{ id: 'rope', a: 'a', b: 'b', maxDistance: 30 }]);
    world.queueRemoveBody('a');
    world.commitMutations();
    assert.equal(world.counts().constraints, 0);
    world.queueAddBody(circle('a', { x: -10 }));
    world.commitMutations();
    world.queueAddConstraint({ id: 'rope', a: 'a', b: 'b', maxDistance: 30 });
    world.commitMutations();
    assert.equal(world.counts().constraints, 1);
  } finally { world.dispose(); }
});

test('body and constraint capacity reject without changing admitted state', async () => {
  const world = await createPhysicsWorld();
  try {
    for (let i = 0; i < 128; i++) world.queueAddBody(circle(`p${i}`, { x: i * 100 }));
    assert.throws(() => world.queueAddBody(circle('extra')), /capacity/);
    assert.equal(world.snapshot().pending.add.length, 128);
    world.commitMutations();
    for (let i = 0; i < 8; i++) world.queueAddConstraint({ id: `r${i}`, a: `p${i}`, b: `p${i + 1}`, maxDistance: 150 });
    assert.throws(() => world.queueAddConstraint({ id: 'extra', a: 'p0', b: 'p1', maxDistance: 150 }), /capacity/);
    assert.equal(world.snapshot().pending.addConstraints.length, 8);
    world.commitMutations();
    assert.equal(world.counts().constraints, 8);
  } finally { world.dispose(); }
});

test('a step whose collision events exceed capacity throws instead of dropping them', async () => {
  // 128 coincident props give 8,128 pairs; the overlapping statics push one step past 8,192.
  const world = await createPhysicsWorld();
  try {
    for (let i = 0; i < 128; i++) world.queueAddBody(circle(`p${i}`, { x: (i % 4) * 0.25 }));
    for (let i = 0; i < 4; i++) world.queueAddBody({ id: `s${i}`, kind: 'static', shape: { kind: 'box', hx: 40, hy: 40 }, x: 0, y: 0 });
    world.commitMutations();
    assert.throws(() => world.step(), /physics event capacity exceeded/);
  } finally { world.dispose(); }
});

test('same insertion-independent mutation set continues deterministically', async () => {
  const a = await createPhysicsWorld(), b = await createPhysicsWorld();
  try {
    const specs = [circle('z', { x: -30, vx: 150 }), circle('a', { x: 30, vx: -150 }),
      { id: 'wall', kind: 'static', shape: { kind: 'box', hx: 10, hy: 100 }, x: 200, y: 0 }];
    for (const item of specs) a.queueAddBody(item);
    for (const item of specs.toReversed()) b.queueAddBody(item);
    for (let tick = 0; tick < 8; tick++) {
      const left = a.step(), right = b.step();
      assert.deepEqual(left, right);
      assert.deepEqual(a.snapshot(), b.snapshot());
      assert.deepEqual(a.drainContacts(), b.drainContacts());
    }
  } finally { a.dispose(); b.dispose(); }
});

test('static geometry is excluded from movement paths and box tip speed is bounded', async () => {
  const world = await createPhysicsWorld();
  try {
    for (let i = 0; i < 200; i++) world.queueAddBody({ id: `s${i}`, kind: 'static',
      shape: { kind: 'box', hx: 2, hy: 2 }, x: i * 30, y: 500 });
    world.queueAddBody({ id: 'spin', kind: 'prop', shape: { kind: 'box', hx: 6, hy: 6 },
      x: 0, y: 0, vx: 100, omega: 20 });
    const result = world.step();
    assert.deepEqual(Object.keys(result.paths), ['spin']);
    assert.deepEqual(Object.keys(result.distance), ['spin']);
    const state = world.getTransform('spin');
    const tipSpeed = Math.hypot(state.vx, state.vy) + Math.abs(state.omega) * Math.hypot(6, 6);
    assert.ok(tipSpeed <= 0.8 * 6 / 0.0125 + 0.001);
  } finally { world.dispose(); }
});

test('removal cancels commands for old generation and a same-boundary create', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('id'));
    world.queueRemoveBody('id');
    world.commitMutations();
    assert.equal(world.hasBody('id'), false);
    world.queueAddBody(circle('id'));
    world.commitMutations();
    world.queueForce('id', { x: 100000, y: 0 });
    world.queueImpulse('id', { x: 100000, y: 0 });
    world.queueRemoveBody('id');
    world.queueAddBody(circle('id', { x: 50 }));
    world.step();
    const current = world.getTransform('id');
    assert.ok(Math.abs(current.x - 50) < 0.001);
    assert.ok(Math.abs(current.vx) < 0.001);
    assert.deepEqual(world.snapshot().pending.forces, []);
    assert.deepEqual(world.snapshot().pending.impulses, []);
  } finally { world.dispose(); }
});

test('compact snapshot omits static bodies but retains dynamic generation and pending work', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('p'));
    world.queueAddBody({ id: 'wall', kind: 'static', shape: { kind: 'box', hx: 5, hy: 5 }, x: 50, y: 0 });
    world.commitMutations();
    world.queueAddConstraint({ id: 'tether', a: 'p', b: 'wall', maxDistance: 50 });
    world.queueImpulse('p', { x: 1, y: 0 });
    const compact = world.snapshot({ includeStatic: false });
    assert.deepEqual(compact.bodies.map(body => body.spec.id), ['p']);
    assert.equal(compact.bodies[0].generation, world.getGeneration('p'));
    assert.equal(compact.pending.addConstraints[0].id, 'tether');
    assert.equal(compact.pending.impulses[0].id, 'p');
    assert.deepEqual(world.snapshot().bodies.map(body => body.spec.id), ['p', 'wall']);
  } finally { world.dispose(); }
});

test('teleport detaches ropes and clears old motor, force, and impulse', async () => {
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('p'));
    world.queueAddBody(circle('q', { x: 20 }));
    world.queueAddConstraint({ id: 'rope', a: 'p', b: 'q', maxDistance: 30 });
    world.commitMutations();
    const originalGeneration = world.getGeneration('p');
    world.setMotor('p', { x: 100, y: 0, accel: 1000 });
    world.queueForce('p', { x: 1000, y: 0 });
    world.queueImpulse('p', { x: 100, y: 0 });
    world.setTransform('p', { x: 100, y: 10, angle: 0 });
    assert.equal(world.counts().constraints, 0);
    assert.equal(world.snapshot().bodies.find(body => body.spec.id === 'p').motor, undefined);
    world.step();
    assert.ok(Math.abs(world.getTransform('p').vx) < 0.001);
    assert.ok(world.getGeneration('p') > originalGeneration);
    world.queueRemoveBody('p');
    world.queueAddBody(circle('p', { x: 100 }));
    world.commitMutations();
    assert.ok(world.getGeneration('p') > originalGeneration);
  } finally { world.dispose(); }
});

test('overspeed initial body is rejected before queue admission', async () => {
  const world = await createPhysicsWorld();
  try {
    assert.throws(() => world.queueAddBody(circle('fast', { vx: 769 })), /swept-query-or-explicit-teleport/);
    assert.throws(() => world.queueAddBody({ id: 'spin', kind: 'prop',
      shape: { kind: 'box', hx: 6, hy: 6 }, x: 0, y: 0, omega: 100 }),
    /swept-query-or-explicit-teleport/);
    assert.deepEqual(world.snapshot().pending.add, []);
    assert.equal(world.counts().dynamic, 0);
  } finally { world.dispose(); }
});

test('finite but backend-hostile magnitudes are rejected atomically', async () => {
  const world = await createPhysicsWorld();
  try {
    assert.throws(() => world.queueAddBody(circle('huge', { x: 1e308 })), /representable bounds/);
    assert.throws(() => world.queueAddBody(circle('tiny-mass', { mass: 1e-300 })), /mass/);
    assert.throws(() => world.queueAddBody(circle('tiny-radius', { shape: { kind: 'circle', radius: 1e-300 } })), /dimension/);
    assert.deepEqual(world.snapshot().pending.add, []);
    world.queueAddBody(circle('good'));
    world.commitMutations();
    assert.throws(() => world.queueImpulse('good', { x: 1e308, y: 0 }), /representable bounds/);
    assert.deepEqual(world.snapshot().pending.impulses, []);
    assert.equal(world.getTransform('good').x, 0);
  } finally { world.dispose(); }
});

test('map geometry shares one fixed body but keeps its own pose, contacts and removal', async () => {
  const world = await createPhysicsWorld();
  try {
    const wall = (id, x, angle = 0) => ({ id, kind: 'static', mapGeometry: true, shape: { kind: 'box', hx: 20, hy: 200 }, x, y: 0, angle });
    world.queueAddBody(wall('wall:a', 100)); world.queueAddBody(wall('wall:b', -100, 0.5));
    world.queueAddBody(circle('p', { vx: 100 }));
    world.commitMutations();
    assert.deepEqual(world.getTransform('wall:b'), { x: -100, y: 0, angle: 0.5, vx: 0, vy: 0, omega: 0, sleeping: world.getTransform('wall:b').sleeping });
    assert.equal(world.counts().static, 2);
    for (let i = 0; i < 20; i++) world.step();
    assert.ok(world.drainContacts().some(contact => contact.a === 'p' && contact.b === 'wall:a' && contact.type === 'start'));
    assert.ok(world.getTransform('p').x < 100 - 20, 'the wall stops the body');
    assert.throws(() => world.queueAddConstraint({ id: 'rope', a: 'p', b: 'wall:a', maxDistance: 50 }), /map geometry/);
    assert.throws(() => world.queueAddBody({ ...circle('q'), mapGeometry: true }), /static/);
    world.queueRemoveBody('wall:a'); world.commitMutations();
    assert.equal(world.getTransform('wall:a'), undefined);
    assert.equal(world.getTransform('wall:b').x, -100);
    assert.equal(world.counts().static, 1);
  } finally { world.dispose(); }
});

// The world steps Rapier's pipeline directly and removes bodies without rapier.js's whole-world re-sync (42.22), so
// it must keep the wrapper's handle maps current itself: every body, collider and joint the engine holds is mapped,
// and nothing it removed stays mapped.
test('stepping refuses a world holding a rapier soft body, whose handles only the skipped sync maps', async () => {
  const RAPIER = (await import('@dimforge/rapier2d-compat')).default;
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody(circle('a')); world.commitMutations(); world.step();
    world.native.createSoftBody(RAPIER.SoftBodyDesc.rope({ x: 0, y: 0 }, { x: 40, y: 0 }, 4));
    assert.throws(() => world.step(), /soft body/);
  } finally { world.dispose(); }
});

test('rapier.js handle maps match the engine through steps, removals and ropes', async () => {
  const world = await createPhysicsWorld();
  try {
    const native = world.native;
    const check = () => {
      assert.equal(native.colliders.getAll().length, native.colliders.raw.len());
      assert.equal(native.bodies.getAll().length, native.bodies.raw.len());
      assert.equal(native.impulseJoints.getAll().length, native.impulseJoints.raw.len());
      for (const collider of native.colliders.getAll()) assert.ok(native.colliders.raw.contains(collider.handle));
    };
    const wall = (id, x) => ({ id, kind: 'static', mapGeometry: true, shape: { kind: 'box', hx: 20, hy: 200 }, x, y: 0 });
    for (let i = 0; i < 5; i++) world.queueAddBody(wall(`wall:${i}`, 200 + 50 * i));
    world.queueAddBody(circle('a', { x: -10, vx: 80 })); world.queueAddBody(circle('b', { x: 10, vx: 80 }));
    world.queueAddConstraint({ id: 'rope', a: 'a', b: 'b', maxDistance: 30 });
    world.commitMutations(); check();
    for (let i = 0; i < 10; i++) world.step();
    check();
    world.queueRemoveBody('a'); world.queueRemoveBody('wall:2'); world.commitMutations(); check();
    assert.equal(world.counts().constraints, 0);
    world.queueAddBody(circle('a', { x: -40 })); world.commitMutations();
    for (let i = 0; i < 10; i++) world.step();
    check();
    world.queueRemoveBody('b'); world.queueRemoveBody('a'); world.commitMutations(); check();
  } finally { world.dispose(); }
});
