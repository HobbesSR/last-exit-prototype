import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsWorld } from '../shared/physics/world.ts';

// P2 body radius is 0.8 of each role's measured nominal rendered head radius.
const contestant = 11.2875;
const gladiator = 16.25;
const actor = (id, x, y, radius = contestant) => ({ id, kind: 'actor',
  shape: { kind: 'circle', radius }, x, y, mass: 1, friction: 0, restitution: 0 });
const wall = (id, x, y, hx, hy) => ({ id, kind: 'static',
  shape: { kind: 'box', hx, hy }, x, y, friction: 0, restitution: 0 });
const drive = (world, id, x, y) => world.setMotor(id, { x, y, accel: 3600 });
const closest = (trace, a, b) => Math.min(...trace.flatMap(paths => paths[a].map((p, i) =>
  Math.hypot(p.x - paths[b][i].x, p.y - paths[b][i].y))));

function assertSubsteps(paths, actors, walls, label) {
  for (let substep = 0; substep < 5; substep++) {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      const p = paths[a.id][substep];
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${label}: ${a.id} finite at ${substep}`);
      for (const b of actors.slice(i + 1)) {
        const q = paths[b.id][substep];
        const penetration = a.shape.radius + b.shape.radius - Math.hypot(p.x - q.x, p.y - q.y);
        assert.ok(penetration <= 0.5 + 1e-3,
          `${label}: ${a.id}/${b.id} penetration ${penetration} at ${substep}`);
      }
      for (const box of walls) {
        const dx = Math.max(Math.abs(p.x - box.x) - box.shape.hx, 0);
        const dy = Math.max(Math.abs(p.y - box.y) - box.shape.hy, 0);
        assert.ok(Math.hypot(dx, dy) >= a.shape.radius - 0.5 - 1e-3,
          `${label}: ${a.id} crosses ${box.id} at ${substep}`);
      }
    }
  }
}

async function simulate(specs, motors, ticks, label) {
  const world = await createPhysicsWorld();
  const actors = specs.filter(spec => spec.kind === 'actor');
  const walls = specs.filter(spec => spec.kind === 'static');
  try {
    for (const spec of specs) world.queueAddBody(spec);
    world.commitMutations();
    for (const [id, x, y] of motors) drive(world, id, x, y);
    const trace = [];
    for (let tick = 0; tick < ticks; tick++) {
      const result = world.step();
      assertSubsteps(result.paths, actors, walls, `${label} tick ${tick}`);
      trace.push(result.paths);
    }
    return trace;
  } finally { world.dispose(); }
}

test('head-on and glancing actors contact while a tangent keeps sliding', async () => {
  const headOn = await simulate([
    actor('left', -45, 0), actor('right', 45, 0),
  ], [['left', 180, 0], ['right', -180, 0]], 18, 'head-on');
  const lastHead = headOn.at(-1);
  assert.ok(closest(headOn, 'left', 'right') < 2 * contestant + 0.8, 'head-on actors reach contact');
  assert.ok(lastHead.left.at(-1).x < lastHead.right.at(-1).x, 'head-on actors keep order');

  const glancing = await simulate([
    actor('moving', -35, 15), actor('blocker', 0, 0),
  ], [['moving', 180, 0], ['blocker', 0, 0]], 14, 'glancing');
  assert.ok(closest(glancing, 'moving', 'blocker') < 2 * contestant + 0.8, 'glancing actors reach contact');
  assert.ok(glancing.at(-1).moving.at(-1).y > 15, 'tangential motion continues');
});

test('mixed radii use the sum of physical footprints', async () => {
  const trace = await simulate([
    actor('contestant', -45, 0), actor('gladiator', 45, 0, gladiator),
  ], [['contestant', 180, 0], ['gladiator', -160, 0]], 18, 'mixed radii');
  const final = trace.at(-1);
  assert.ok(closest(trace, 'contestant', 'gladiator') < contestant + gladiator + 0.8);
  assert.ok(final.contestant.at(-1).x < final.gladiator.at(-1).x);
});

test('coincident-centre ties have finite, insertion-independent stable-ID outcomes', async () => {
  // The initial overlap is deliberately excluded from the penetration gate: this
  // case witnesses deterministic tie resolution, not a legal spawn placement.
  const specs = [actor('a', 0, 0), actor('b', 0, 0), actor('c', 0, 0)];
  const run = async order => {
    const world = await createPhysicsWorld();
    try {
      for (const spec of order) world.queueAddBody(spec);
      world.commitMutations();
      for (const spec of specs) drive(world, spec.id, 0, 0);
      const trace = [];
      for (let tick = 0; tick < 12; tick++) {
        const { paths } = world.step();
        for (const path of Object.values(paths)) for (const p of path)
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        trace.push(paths);
      }
      return trace;
    } finally { world.dispose(); }
  };
  assert.deepEqual(await run(specs), await run(specs.toReversed()));
});

test('corner crowd and narrow doorway queue stay outside static boxes', async () => {
  const corner = await simulate([
    wall('vertical', 0, 0, 3, 80), wall('horizontal', -40, 80, 43, 3),
    actor('a', -40, 30), actor('b', -64, 30), actor('c', -88, 30),
  ], [['a', 180, 180], ['b', 180, 180], ['c', 180, 180]], 24, 'corner crowd');
  for (const paths of corner) for (const path of Object.values(paths)) for (const p of path) {
    assert.ok(p.x < -3, 'crowd never crosses the vertical wall');
    assert.ok(p.y < 77, 'crowd never crosses the horizontal wall');
  }

  const doorway = await simulate([
    wall('upper', 0, -65, 3, 50), wall('lower', 0, 65, 3, 50),
    actor('blocker', 25, 0), actor('first', -25, 0), actor('second', -49, 0),
    actor('third', -73, 0),
  ], [['blocker', 0, 0], ['first', 180, 0], ['second', 180, 0], ['third', 180, 0]],
  30, 'doorway queue');
  const end = doorway.at(-1);
  assert.ok(end.first.at(-1).x < end.blocker.at(-1).x, 'stationary blocker holds the queue');
  assert.ok(end.second.at(-1).x < end.first.at(-1).x);
  assert.ok(end.third.at(-1).x < end.second.at(-1).x);
});
