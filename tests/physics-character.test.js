import assert from 'node:assert/strict';
import test from 'node:test';
import { PHYSICS_VERSION, createGame, disposePhysics, enqueuePhysicsAttachment, enqueuePhysicsImpulse,
  setInput, snapshot, stateOf, step, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { setDoor } from '../shared/simulation/doors.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { openArea } from './helpers/arena.js';

function parts(contestants = 2, contentId = 'content-6') {
  const map = { seed: 439, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [],
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
  const s = await createGame(439, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}

const physicsParts = parts();
const byId = s => Object.fromEntries(s.players.map(p => [p.id, p]));
const body = (s, id) => snapshot(s).physics.world.bodies.find(b => b.spec.id === `actor:${id}`);
const input = (s, id, fields) => assert.ok(setInput(s, id, { seq: s.tick + 1, ...fields }));

// The projectile hit envelope (the contestant's 15 and the gladiator's 26, wider than the movement bodies) is held by
// `rust/core/src/tick/sweep.rs` `a_shot_hurts_inside_the_old_hit_envelope_and_not_outside_it`.

test('content-6 pins measured narrow bodies and keeps the hurt radius', async () => {
  const p2 = await game();
  try {
    assert.equal(p2.version, PHYSICS_VERSION);
    assert.throws(() => { p2.map.motorSurfaces = []; }, TypeError, 'an absent floor list is pinned too');
    assert.deepEqual([body(p2, 'c0').spec.shape.radius, body(p2, 'g0').spec.shape.radius], [11.2875, 16.25]);
    assert.deepEqual([p2.content.actorPhysics.geometry.contestant.hurtRadius,
      p2.content.actorPhysics.geometry.gladiator.hurtRadius], [12, 23]);
  } finally { disposePhysics(p2); }
});

test('invalid physical tuning is refused and caller edits cannot retune an admitted match', async () => {
  for (const change of [p => p.maxSpeed = NaN, p => p.geometry.contestant.bodyRadius = 30,
    p => p.geometry.gladiator.hurtRadius = 16]) {
    const { map, content } = parts(1); change(content.actorPhysics);
    await assert.rejects(createGame(439, map, content), /actor physics|narrow body/);
  }
  const fixture = parts(1);
  const floor = { id: 'ice', x: 100, y: 350, w: 200, h: 100, priority: 1, speed: 1, traction: 0.1, braking: 0.1 };
  fixture.map.motorSurfaces = [floor];
  const s = await game(fixture);
  try {
    fixture.content.actorPhysics.acceleration = 1; floor.traction = 1;
    input(s, 'c0', { x: 1 }); step(s);
    assert.ok(Math.abs(snapshot(s).bodies[0].vx - 18) < 0.01);
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
    assert.ok(Math.abs(snapshot(s).bodies[0].vx - 36) < 0.01, 'the winning surface sets acceleration');
    for (let i = 0; i < 5; i++) step(s);
    assert.ok(Math.abs(snapshot(s).bodies[0].vx - 90) < 0.01, 'the winning surface sets speed');
    input(s, 'c0', { x: 0 }); step(s);
    assert.ok(Math.abs(snapshot(s).bodies[0].vx - 54) < 0.01, 'the winning surface sets braking');
  } finally { disposePhysics(s); }
});

test('gate closure defers for an occupied footprint and succeeds after the actor leaves', async () => {
  const { map, content } = parts(1);
  map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'gate' }];
  const s = await game({ map, content });
  try {
    assert.deepEqual(teleport(s, 'c0', 300, 400), { x: 300, y: 400 });
    setDoor(s, 0, { open: false }); synchronizePhysics(s);
    assert.equal(s.map.gates[0].open, true);
    assert.equal(physicsRuntime(s).world.hasBody('gate:door'), false);
    assert.deepEqual(teleport(s, 'c0', 200, 400), { x: 200, y: 400 });
    setDoor(s, 0, { open: false }); synchronizePhysics(s);
    assert.equal(s.map.gates[0].open, false);
    assert.equal(physicsRuntime(s).world.hasBody('gate:door'), true);
  } finally { disposePhysics(s); }
});

test('door interaction respects narrow body clearance and solid prop occupancy', async () => {
  const blocked = parts(1);
  blocked.map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'door' }];
  blocked.map.obstacles = [{ id: 'prop:door', x: 292, y: 392, w: 16, h: 16 }];
  const sBlocked = await game(blocked);
  try {
    const p = byId(sBlocked).c0;
    assert.ok(teleport(sBlocked, p.id, 276, 400)); // clear of body 11.2875; legacy radius12 would touch.
    setInput(sBlocked, p.id, { seq: 1, interact: true });
    step(sBlocked);
    assert.equal(stateOf(sBlocked).gates[0].open, true, 'prop prevents requested close before discovery observes it');
  } finally { disposePhysics(sBlocked); }

  const clear = parts(1);
  clear.map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'door' }];
  const sClear = await game(clear);
  try {
    const p = byId(sClear).c0;
    assert.ok(teleport(sClear, p.id, 276, 400));
    setInput(sClear, p.id, { seq: 1, interact: true });
    step(sClear);
    assert.equal(stateOf(sClear).gates[0].open, false, 'clear narrow body permits closing');
  } finally { disposePhysics(sClear); }
});

test('a door is not closed on a transit that landed in it earlier the same phase', async () => {
  const fixture = parts(1);
  fixture.map.gates = [{ id: 'door', x: 300, y: 400, w: 24, h: 60, open: true, kind: 'door' }];
  fixture.map.stations = [{ id: 'from', x: 650, y: 400 }, { id: 'to', x: 300, y: 400 }];
  const s = await game(fixture);
  try {
    const { c0, g0 } = byId(s);
    assert.ok(teleport(s, c0.id, 276, 400)); // its body alone leaves the door clear, as above
    setInput(s, g0.id, { seq: 1, interact: true });
    step(s);
    const afterTransit = stateOf(s).players.find(p => p.id === g0.id);
    assert.ok(Math.abs(afterTransit.x - 300) < 30 && afterTransit.railCd > 0, 'transit landed in the doorway');
    setInput(s, c0.id, { seq: 1, interact: true });
    step(s);
    assert.equal(stateOf(s).gates[0].open, true, 'refused while the gladiator occupies the doorway');
  } finally { disposePhysics(s); }
});

test('blocked transit preserves cooldown; a valid landing clears motion and constraints', async () => {
  const blocked = parts(1);
  blocked.map.stations = [{ id: 'from', x: 650, y: 400 }, { id: 'to', x: 400, y: 650 }];
  blocked.map.obstacles = [{ id: 'prop:landing', x: 250, y: 500, w: 300, h: 300 }];
  const sBlocked = await game(blocked);
  try {
    const p = byId(sBlocked).g0;
    setInput(sBlocked, p.id, { seq: 1, interact: true });
    step(sBlocked);
    const gState = stateOf(sBlocked).players.find(q => q.id === p.id);
    assert.deepEqual({ x: gState.x, y: gState.y, cd: gState.railCd }, { x: 650, y: 400, cd: 0 });
  } finally { disposePhysics(sBlocked); }

  const clear = parts(1);
  clear.map.stations = [{ id: 'from', x: 650, y: 400 }, { id: 'to', x: 400, y: 650 }];
  const sClear = await game(clear);
  try {
    const p = byId(sClear).g0;
    setInput(sClear, p.id, { seq: 1, moveX: 1, interact: true });
    step(sClear);
    const gState = stateOf(sClear).players.find(q => q.id === p.id);
    assert.deepEqual({ x: gState.x, y: gState.y, cd: gState.railCd }, { x: 400, y: 650, cd: 180 });
  } finally { disposePhysics(sClear); }
});

test('an impossible initial placement is refused', async () => {
  const { map, content } = parts(1);
  map.playableArea.rows = [];
  await assert.rejects(() => game({ map, content }), /no legal physics placement/);
});

test('missing actor physics and invalid motor surfaces are rejected during creation', async () => {
  const stripped = parts(1);
  delete stripped.content.actorPhysics;
  await assert.rejects(game(stripped), /actor physics required/);
  const p2 = parts(1);
  p2.map.motorSurfaces = [{ id: '', x: 0, y: 0, w: -1, h: 0, priority: NaN, speed: 2, traction: 2, braking: 2 }];
  await assert.rejects(game(p2), /invalid motor surface/);
});
