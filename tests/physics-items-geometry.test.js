import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';

function arena({ width = 800, height = 800, cellSize = 100, rows, obstacles = [], props = [], items = [] } = {}) {
  return { seed: 37, width, height, playableArea: { cellSize, rows: rows ?? Array.from(
    { length: height / cellSize }, (_, y) => ({ y, runs: [[0, width / cellSize]] })) },
    modules: [], buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [],
    physicsProps: props, entry: { x: 80, y: height / 2 }, exit: { x: width - 50, y: height / 2 },
    spawns: [{ x: 150, y: height / 2 }] };
}
const content = () => ({ ...structuredClone(contentById('content-physics-5')),
  roster: { contestants: ['A'], gladiators: [] }, discovery: false });
const cell = (id, x, y) => ({ id, kind: 'cell', charge: 10, x, y });
const boxRight = (pose, hx, hy) => pose.x + Math.abs(Math.cos(pose.angle)) * hx + Math.abs(Math.sin(pose.angle)) * hy;

async function game(map) {
  const s = await createPhysicsGame(37, map, content());
  s.players[0].bot = false;
  return { s, world: physicsRuntime(s).world };
}

test('P5 loot is solid against mask holes, outer bounds, and a thin static wall at speed cap', async () => {
  const rows = Array.from({ length: 8 }, (_, y) => ({ y,
    runs: y >= 2 && y < 6 ? [[0, 3], [4, 8]] : [[0, 8]] }));
  const map = arena({ rows, obstacles: [{ id: 'thin', x: 500, y: 330, w: 2, h: 140 }],
    items: [cell('hole', 240, 400), cell('wall', 450, 400), cell('outer', 730, 650)] });
  const { s, world } = await game(map);
  try {
    for (const id of ['hole', 'wall', 'outer']) {
      assert.equal(world.hasBody(`item:${id}`), true);
      world.queueImpulse(`item:${id}`, { x: 300, y: 0 });
    }
    for (let tick = 0; tick < 24; tick++) {
      const { paths } = world.step();
      for (const p of paths['item:hole']) assert.ok(p.x + 6 <= 300.5, `hole at tick ${tick}: ${p.x}`);
      for (const p of paths['item:wall']) assert.ok(p.x + 6 <= 500.5, `thin wall at tick ${tick}: ${p.x}`);
      for (const p of paths['item:outer']) assert.ok(p.x + 6 <= 800.5, `outer edge at tick ${tick}: ${p.x}`);
    }
    assert.ok(world.getTransform('item:hole').x > 260, 'loot reached hole contact');
    assert.ok(world.getTransform('item:wall').x > 470, 'loot reached wall contact');
    assert.ok(world.getTransform('item:outer').x > 750, 'loot reached outer contact');
  } finally { disposePhysics(s); }
});

test('rotating fast prop and actor crowd cannot drive a full box footprint through a thin wall', async () => {
  const map = arena({ obstacles: [{ id: 'thin', x: 500, y: 260, w: 2, h: 280 }],
    props: [{ id: 'crate', profile: 'crate', x: 450, y: 400, angle: 0.2 }] });
  const { s, world } = await game(map);
  try {
    world.queueAddBody({ id: 'prop:fast', kind: 'prop', shape: { kind: 'box', hx: 24, hy: 12 },
      x: 410, y: 300, vx: 400, omega: 10, mass: 2, friction: 0, restitution: 0 });
    for (let i = 0; i < 3; i++) world.queueAddBody({ id: `crowd:${i}`, kind: 'actor',
      shape: { kind: 'circle', radius: 10 }, x: 403 - i * 22, y: 400, friction: 0, restitution: 0 });
    world.commitMutations();
    for (let i = 0; i < 3; i++) world.setMotor(`crowd:${i}`, { x: 200, y: 0, accel: 3600 });
    let maximumCrateX = 0;
    for (let tick = 0; tick < 30; tick++) {
      const { paths } = world.step();
      for (const id of ['prop:fast', 'prop:crate']) {
        for (const p of paths[id]) assert.ok(p.x < 500, `${id} centre crossed wall at tick ${tick}`);
        const pose = world.getTransform(id);
        assert.ok(boxRight(pose, 24, 12) <= 500.5,
          `${id} rotated rightmost vertex crossed wall at tick ${tick}: ${boxRight(pose, 24, 12)}`);
      }
      maximumCrateX = Math.max(maximumCrateX, world.getTransform('prop:crate').x);
    }
    assert.ok(maximumCrateX > 452, `crowd pushes crate: ${maximumCrateX}`);
    assert.ok(Math.abs(world.getTransform('prop:fast').angle) > 0.2, 'fast body rotated while moving');
  } finally { disposePhysics(s); }
});

test('far corner at maximum geometry extent retains physical loot inside outer boundary', async () => {
  const width = 51840, height = 25920, cellSize = 864;
  const map = arena({ width, height, cellSize, items: [cell('corner', width - 70, height - 70)] });
  map.spawns[0] = { x: 150, y: 150 };
  const { s, world } = await game(map);
  try {
    assert.equal(world.hasBody('item:corner'), true);
    world.queueImpulse('item:corner', { x: 300, y: 300 });
    for (let tick = 0; tick < 20; tick++) {
      const { paths } = world.step();
      for (const p of paths['item:corner']) {
        assert.ok(p.x + 6 <= width + 0.5, `far x at tick ${tick}: ${p.x}`);
        assert.ok(p.y + 6 <= height + 0.5, `far y at tick ${tick}: ${p.y}`);
      }
    }
  } finally { disposePhysics(s); }
});
