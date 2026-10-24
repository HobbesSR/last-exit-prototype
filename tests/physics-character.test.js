import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, enqueuePhysicsAttachment, enqueuePhysicsImpulse,
  setInput, snapshot, step, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { solvePhysicsProjectiles } from '../shared/simulation/physics-projectiles.ts';
import { interact } from '../shared/simulation/interactions.ts';

function parts(contestants = 2, contentId = 'content-physics-2') {
  const map = { seed: 439, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: Array.from({ length: contestants }, (_, i) => ({ x: 150 + i * 90, y: 400 })),
    hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById(contentId));
  content.roster = { contestants: Array.from({ length: contestants }, (_, i) => `C${i}`),
    gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

async function game(parts = undefined) {
  const { map, content } = parts ?? structuredClone(physicsParts);
  const s = await createPhysicsGame(439, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}

const physicsParts = parts();
const byId = s => Object.fromEntries(s.players.map(p => [p.id, p]));
const body = (s, id) => snapshot(s).physics.world.bodies.find(b => b.spec.id === `actor:${id}`);
const input = (s, id, fields) => assert.ok(setInput(s, id, { seq: s.tick + 1, ...fields }));

test('projectiles retain their old hit envelope beyond the narrower movement body', async () => {
  const s = await game(parts(1));
  try {
    for (const [id, offset] of [['c0', 14], ['g0', 25]]) {
      const target = byId(s)[id], hp = target.hp, shield = target.shield;
      s.projectiles.push({ id: ++s.serial, owner: 'absent', x: target.x - 50, y: target.y + offset,
        dx: 100, dy: 0, life: 10, damage: 7 });
      solvePhysicsProjectiles(s, {});
      assert.equal(target.hp + target.shield, hp + shield - 7, `${id} retains old projectile allowance`);
      assert.equal(s.projectiles.length, 0);
    }
  } finally { disposePhysics(s); }
});

test('P2 pins measured narrow bodies and physics-2 while P1 keeps its radius and version', async () => {
  const p2 = await game();
  const p1 = await game(parts(2, 'content-1'));
  try {
    assert.equal(p2.version, 'last-exit-0.8-physics-2');
    assert.equal(p1.version, 'last-exit-0.8-physics-1');
    assert.deepEqual([body(p2, 'c0').spec.shape.radius, body(p2, 'g0').spec.shape.radius], [11.2875, 16.25]);
    assert.deepEqual([body(p1, 'c0').spec.shape.radius, body(p1, 'g0').spec.shape.radius], [12, 23]);
    assert.deepEqual([p2.content.actorPhysics.geometry.contestant.hurtRadius,
      p2.content.actorPhysics.geometry.gladiator.hurtRadius], [12, 23]);
  } finally { disposePhysics(p2); disposePhysics(p1); }
});

test('invalid physical tuning is refused and caller edits cannot retune an admitted match', async () => {
  for (const change of [p => p.maxSpeed = NaN, p => p.geometry.contestant.bodyRadius = 30,
    p => p.geometry.gladiator.hurtRadius = 16]) {
    const { map, content } = parts(1); change(content.actorPhysics);
    await assert.rejects(createPhysicsGame(439, map, content), /actor physics|narrow body/);
  }
  const fixture = parts(1);
  const floor = { id: 'ice', x: 100, y: 350, w: 200, h: 100, priority: 1, speed: 1, traction: 0.1, braking: 0.1 };
  fixture.map.motorSurfaces = [floor];
  const s = await game(fixture);
  try {
    fixture.content.actorPhysics.acceleration = 1; floor.traction = 1;
    input(s, 'c0', { x: 1 }); step(s);
    assert.equal(body(s, 'c0').motor.accel, 360);
    assert.ok(Object.isFrozen(s.content.actorPhysics.geometry.contestant));
    assert.ok(Object.isFrozen(s.map.motorSurfaces[0]));
  } finally { disposePhysics(s); }
});

test('overlapping floor surfaces choose priority and stable ID for speed, traction and braking', async () => {
  const { map, content } = parts(1);
  map.motorSurfaces = [
    { id: 'z', x: 100, y: 350, w: 300, h: 100, priority: 7, speed: 0.7, traction: 0.1, braking: 0.1 },
    { id: 'a', x: 100, y: 350, w: 300, h: 100, priority: 7, speed: 0.5, traction: 0.2, braking: 0.2 },
    { id: 'low', x: 100, y: 350, w: 300, h: 100, priority: 1, speed: 0.1, traction: 0.1, braking: 0.1 },
  ];
  const s = await game({ map, content });
  try {
    input(s, 'c0', { x: 1 }); step(s);
    assert.deepEqual(body(s, 'c0').motor, { x: 90, y: 0, accel: 720 });
    const moved = byId(s).c0.movedThisTick;
    assert.ok(moved > 0 && moved < 4.5);
    input(s, 'c0', { x: 0 }); step(s);
    assert.deepEqual(body(s, 'c0').motor, { x: 0, y: 0, accel: 720 });
    assert.ok(byId(s).c0.movedThisTick > 0, 'low braking preserves external velocity briefly');
  } finally { disposePhysics(s); }
});

test('impulse motion is measured from the solved path and recovers with bounded braking', async () => {
  const s = await game(parts(1));
  try {
    const c = byId(s).c0, start = c.x;
    enqueuePhysicsImpulse(s, 'actor:c0', { x: 300, y: 0 });
    step(s);
    assert.ok(c.movedThisTick > 0);
    assert.ok(c.movedThisTick >= Math.abs(c.x - start) - 1e-5);
    assert.ok(body(s, 'c0').transform.vx > 0 && body(s, 'c0').transform.vx < 300);
    step(s);
    assert.ok(body(s, 'c0').transform.vx < 1, 'braking takes another bounded tick');
  } finally { disposePhysics(s); }
});

test('P2 clamps a queued impulse and total actor speed to pinned content limits', async () => {
  const s = await game(parts(1));
  try {
    enqueuePhysicsImpulse(s, 'actor:c0', { x: 1000, y: 0 });
    assert.deepEqual(snapshot(s).physics.pendingImpulses[0].value, { x: 600, y: 0 });
    input(s, 'c0', { x: 1 }); step(s);
    const transform = body(s, 'c0').transform;
    assert.ok(Math.hypot(transform.vx, transform.vy) <= 600 + 1e-3);
  } finally { disposePhysics(s); }
});

test('reversing the roster leaves each stable-ID actor trajectory equal', async () => {
  const a = await game(), b = await game();
  try {
    b.players.reverse();
    for (let tick = 0; tick < 8; tick++) {
      for (const s of [a, b]) {
        input(s, 'c0', { x: 1 }); input(s, 'c1', { x: -1 }); step(s);
      }
      for (const id of ['c0', 'c1', 'g0']) {
        assert.deepEqual(body(a, id).transform, body(b, id).transform, `${id} tick ${tick}`);
        assert.equal(byId(a)[id].movedThisTick, byId(b)[id].movedThisTick);
      }
    }
  } finally { disposePhysics(a); disposePhysics(b); }
});

test('gate closure defers for an occupied footprint and succeeds after the actor leaves', async () => {
  const { map, content } = parts(1);
  map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'gate' }];
  const s = await game({ map, content });
  try {
    assert.deepEqual(teleport(s, 'c0', 300, 400), { x: 300, y: 400 });
    s.map.gates[0].open = false; synchronizePhysics(s);
    assert.equal(s.map.gates[0].open, true);
    assert.equal(physicsRuntime(s).world.hasBody('gate:door'), false);
    assert.deepEqual(teleport(s, 'c0', 200, 400), { x: 200, y: 400 });
    s.map.gates[0].open = false; synchronizePhysics(s);
    assert.equal(s.map.gates[0].open, false);
    assert.equal(physicsRuntime(s).world.hasBody('gate:door'), true);
  } finally { disposePhysics(s); }
});

test('door interaction respects narrow body clearance and solid prop occupancy', async () => {
  const fixture = parts(1);
  fixture.map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'door' }];
  const s = await game(fixture);
  try {
    const p = byId(s).c0, world = physicsRuntime(s).world;
    assert.ok(teleport(s, p.id, 276, 400)); // clear of body 11.2875; legacy radius12 would touch.
    world.queueAddBody({ id: 'prop:door', kind: 'prop', shape: { kind: 'circle', radius: 8 }, x: 300, y: 400 });
    world.commitMutations(); interact(s, p);
    assert.equal(s.map.gates[0].open, true, 'prop prevents requested close before discovery observes it');
    world.queueRemoveBody('prop:door'); world.commitMutations(); interact(s, p);
    assert.equal(s.map.gates[0].open, false, 'clear narrow body permits closing');
    synchronizePhysics(s);
    assert.ok(world.hasBody('gate:door'));
  } finally { disposePhysics(s); }
});

test('blocked transit preserves cooldown; a valid landing clears motion and constraints', async () => {
  const fixture = parts(1);
  fixture.map.stations = [{ id: 'from', x: 650, y: 400 }, { id: 'to', x: 400, y: 650 }];
  const s = await game(fixture);
  try {
    const p = byId(s).g0, world = physicsRuntime(s).world;
    world.queueAddBody({ id: 'prop:landing', kind: 'prop', shape: { kind: 'circle', radius: 150 }, x: 400, y: 650 });
    world.commitMutations();
    const effects = s.effects.length;
    interact(s, p); synchronizePhysics(s);
    assert.deepEqual({ x: p.x, y: p.y, cd: p.railCd, effects: s.effects.length }, { x: 650, y: 400, cd: 0, effects });
    world.queueRemoveBody('prop:landing'); world.commitMutations();
    world.queueAddConstraint({ id: 'transit-rope', a: 'actor:g0', b: 'actor:c0', maxDistance: 600 });
    world.commitMutations(); world.setMotor('actor:g0', { x: 100, y: 0, accel: 3600 });
    interact(s, p); synchronizePhysics(s);
    assert.deepEqual({ x: p.x, y: p.y, cd: p.railCd }, { x: 400, y: 650, cd: 180 });
    assert.equal(world.counts().constraints, 0);
    assert.equal(body(s, 'g0').motor, undefined);
    assert.equal(body(s, 'g0').transform.vx, 0);
    assert.ok(snapshot(s).physics.discontinuities.some(d => d.id === 'actor:g0' && d.kind === 'placed'));
  } finally { disposePhysics(s); }
});

test('teleport rejects actor and prop overlap, then resets motion, joint and generation', async () => {
  const s = await game();
  try {
    const world = physicsRuntime(s).world;
    assert.equal(teleport(s, 'c0', byId(s).c1.x, byId(s).c1.y), null);
    world.queueAddBody({ id: 'prop:test', kind: 'prop', shape: { kind: 'circle', radius: 12 }, x: 350, y: 400 });
    world.commitMutations();
    assert.equal(teleport(s, 'c0', 350, 400), null);
    enqueuePhysicsAttachment(s, { id: 'rope', a: 'actor:c0', b: 'actor:c1', maxDistance: 120 });
    input(s, 'c0', { x: 1 });
    step(s);
    assert.equal(world.counts().constraints, 1);
    assert.ok(body(s, 'c0').transform.vx > 0);
    assert.ok(body(s, 'c0').motor.x > 0);
    const generation = world.getGeneration('actor:c0');
    assert.deepEqual(teleport(s, 'c0', 400, 400), { x: 400, y: 400 });
    assert.equal(world.counts().constraints, 0);
    assert.ok(world.getGeneration('actor:c0') > generation);
    assert.deepEqual([body(s, 'c0').transform.vx, body(s, 'c0').transform.vy], [0, 0]);
    assert.equal(body(s, 'c0').motor, undefined);
    assert.ok(snapshot(s).physics.discontinuities.some(d => d.id === 'actor:c0' && d.kind === 'placed'));
    input(s, 'c0', { x: 0 }); step(s);
    assert.ok(snapshot(s).physics.discontinuities.some(d => d.id === 'actor:c0' && d.kind === 'placed'), 'between-tick teleport survives the next capture');
    step(s);
    assert.equal(snapshot(s).physics.discontinuities.some(d => d.id === 'actor:c0'), false, 'ordinary subsequent movement is continuous');
  } finally { disposePhysics(s); }
});

test('elimination removes the actor and its joint with a private discontinuity', async () => {
  const s = await game();
  try {
    const world = physicsRuntime(s).world;
    enqueuePhysicsAttachment(s, { id: 'rope', a: 'actor:c0', b: 'actor:c1', maxDistance: 120 });
    step(s);
    assert.equal(world.counts().constraints, 1);
    byId(s).c0.status = 'eliminated';
    synchronizePhysics(s);
    assert.equal(world.hasBody('actor:c0'), false);
    assert.equal(world.counts().constraints, 0);
    assert.ok(snapshot(s).physics.discontinuities.some(d => d.id === 'actor:c0' && d.kind === 'removed'));
  } finally { disposePhysics(s); }
});

test('an impossible initial placement is refused', async () => {
  const { map, content } = parts(1);
  map.playableArea.rows = [];
  await assert.rejects(() => game({ map, content }), /no legal physics placement/);
});

test('a gladiator respawn defers while a solid prop blocks every nearby placement', async () => {
  const { map, content } = parts(1);
  map.width = 2000; map.exit.x = 1950;
  map.playableArea.rows.forEach(row => { row.runs = [[0, 20]]; });
  map.hunterSpawns = [{ x: 1750, y: 400 }];
  map.stations = [{ id: 'return', x: 1500, y: 400 }];
  const s = await game({ map, content });
  try {
    const g = byId(s).g0, world = physicsRuntime(s).world;
    g.status = 'respawning'; g.respawnAt = s.tick + 1;
    synchronizePhysics(s);
    assert.equal(world.hasBody('actor:g0'), false);
    world.queueAddBody({ id: 'prop:block', kind: 'prop', shape: { kind: 'circle', radius: 200 },
      x: 1500, y: 400 });
    world.commitMutations();
    step(s);
    assert.equal(g.status, 'respawning');
    assert.equal(world.hasBody('actor:g0'), false);
    assert.ok(g.respawnAt > s.tick);
    world.queueRemoveBody('prop:block'); world.commitMutations();
    step(s);
    assert.equal(g.status, 'active');
    assert.equal(world.hasBody('actor:g0'), true);
  } finally { disposePhysics(s); }
});
