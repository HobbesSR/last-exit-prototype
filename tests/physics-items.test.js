import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, setInput, snapshot, step, synchronizePhysics,
  enqueuePhysicsImpulse } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups, dropInventorySlot } from '../shared/simulation/loot.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { eliminate } from '../shared/simulation/lifecycle.ts';

const arena = () => ({ seed: 17, width: 800, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 8]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  entry: { x: 60, y: 200 }, exit: { x: 750, y: 200 }, spawns: [{ x: 120, y: 200 }] });
const content = () => ({ ...structuredClone(contentById('content-physics-5')),
  roster: { contestants: ['A'], gladiators: [] }, discovery: false });
const item = (id, kind, fields = {}) => ({ id, kind, x: 300, y: 200, ...fields });
const carried = (id, kind, fields = {}) => ({ kind, instanceId: id, lineageId: id, ...fields });

async function game(map = arena(), profile = content()) {
  const s = await createPhysicsGame(17, map, profile);
  s.players[0].bot = false;
  return { s, p: s.players[0], runtime: physicsRuntime(s) };
}

function fillDynamic(runtime) {
  let i = 0;
  while (runtime.world.canAddBodies(1)) runtime.world.queueAddBody({ id: `filler:${i++}`, kind: 'prop',
    shape: { kind: 'circle', radius: 2 }, x: 1000 + i * 10, y: 1000 });
  runtime.world.commitMutations();
  return i;
}

test('pickup and drop retain instance identity, quantity, charge, and physical pose', async () => {
  const { s, p, runtime } = await game();
  try {
    s.map.items.push(item('cell-1', 'cell', { charge: 73, quality: 4 }));
    synchronizePhysics(s);
    assert.equal(runtime.world.hasBody('item:cell-1'), true);
    p.x = 300; p.y = 200;
    automaticPickups(s, p, {});
    assert.equal(runtime.world.hasBody('item:cell-1'), false);
    assert.equal(p.inventory[0].instanceId, 'cell-1');
    assert.equal(p.inventory[0].charge, 73);
    assert.equal(p.inventory[0].quality, 4);
    assert.equal(dropInventorySlot(s, p, 0), true);
    assert.equal(p.inventory[0], null);
    assert.equal(s.map.items[0].id, 'cell-1');
    assert.equal(s.map.items[0].charge, 73);
    assert.equal(runtime.world.hasBody('item:cell-1'), true);
    const before = { ...s.map.items[0] };
    step(s);
    const after = s.map.items[0];
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0);
    const frame = snapshot(s), body = frame.bodies.find(b => b.itemId === 'cell-1');
    assert.equal(body.id, 'item:cell-1');
    assert.deepEqual({ x: frame.items[0].x, y: frame.items[0].y }, { x: body.x, y: body.y });
    assert.deepEqual({ x: after.x, y: after.y }, { x: body.x, y: body.y });
    p.inventory[0] = carried('med-3', 'med', { count: 3, quality: 2 });
    assert.equal(dropInventorySlot(s, p, 0), true);
    assert.equal(s.map.items.filter(i => i.lineageId === 'med-3').length, 3);
    assert.equal(s.map.items.filter(i => i.lineageId === 'med-3').reduce((n, i) => n + i.count, 0), 3);
  } finally { disposePhysics(s); }
});

test('exhausted physical slots reject optional drops atomically but retain mandatory death loot', async () => {
  const { s, p, runtime } = await game();
  try {
    fillDynamic(runtime);
    assert.equal(runtime.world.canAddBodies(1), false);
    p.inventory[0] = carried('charged', 'cell', { charge: s.content.cellChargeTicks, quality: 3 });
    p.inventory[1] = carried('second', 'cell', { charge: 19, quality: 2 });
    const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
    assert.equal(dropInventorySlot(s, p, 0), false);
    assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
    eliminate(s, p, null);
    const fallen = s.map.items.find(i => i.id === 'charged');
    assert.equal(fallen.charge, s.content.cellChargeTicks);
    assert.equal(fallen.quality, 3);
    assert.equal(s.map.items.length, 2);
    assert.equal(Number(runtime.world.hasBody('item:charged')) + Number(runtime.world.hasBody('item:second')), 0,
      'reserved roster capacity leaves overflow as logical loot');
    assert.ok(p.inventory.every(i => i === null));
  } finally { disposePhysics(s); }
});

test('full-inventory E swap uses the incoming body slot and removes a sleeping pickup with its joint', async () => {
  const { s, p, runtime } = await game();
  try {
    for (let i = 0; i < 6; i++) p.inventory[i] = carried(`held-${i}`, 'cell', { charge: i + 1 });
    s.map.items.push(item('incoming', 'cell', { x: 120, charge: 79 }));
    synchronizePhysics(s);
    runtime.world.queueAddConstraint({ id: 'item-rope', a: 'item:incoming', b: 'actor:c0', maxDistance: 40 });
    runtime.world.commitMutations();
    for (let i = 0; i < 240 && !runtime.world.getTransform('item:incoming').sleeping; i++) runtime.world.step();
    assert.equal(runtime.world.getTransform('item:incoming').sleeping, true);
    fillDynamic(runtime);
    assert.equal(runtime.world.canAddBodies(1), false);
    interact(s, p);
    assert.equal(p.inventory[0].instanceId, 'incoming');
    assert.equal(p.inventory[0].charge, 79);
    assert.equal(runtime.world.hasBody('item:incoming'), false);
    assert.equal(runtime.world.counts().constraints, 0);
    assert.equal(runtime.world.hasBody('item:held-0'), true);
    assert.equal(s.map.items.find(i => i.id === 'held-0').charge, 1);
  } finally { disposePhysics(s); }
});

test('authored crate moves and rotates without contact damage; floor drag uses priority then ID', async () => {
  const map = arena();
  map.spawns[0].y = 190;
  map.physicsProps = [{ id: 'crate', profile: 'crate', x: 200, y: 200, angle: 0 }];
  map.motorSurfaces = [
    { id: 'z', x: 150, y: 140, w: 300, h: 120, priority: 7, speed: 1, traction: 1, braking: 1, drag: 0.8 },
    { id: 'a', x: 150, y: 140, w: 300, h: 120, priority: 7, speed: 1, traction: 1, braking: 1, drag: 0.2 },
    { id: 'low', x: 150, y: 140, w: 300, h: 120, priority: 1, speed: 1, traction: 1, braking: 1, drag: 0.9 },
  ];
  const { s, p, runtime } = await game(map);
  try {
    s.map.items.push(item('floor-item', 'cell', { x: 410, charge: 10 }));
    synchronizePhysics(s);
    const start = runtime.world.getTransform('prop:crate');
    const hp = p.hp, shield = p.shield;
    for (let i = 0; i < 18; i++) {
      assert.ok(setInput(s, p.id, { seq: s.tick + 1, x: 1 }));
      step(s);
    }
    const end = runtime.world.getTransform('prop:crate');
    assert.ok(end.x > start.x + 0.1, `crate moved from ${start.x} to ${end.x}`);
    assert.ok(Math.abs(end.angle - start.angle) > 0.001, `crate rotated to ${end.angle}`);
    assert.equal(p.hp, hp); assert.equal(p.shield, shield);
    const bodies = snapshot(s).physics.world.bodies;
    assert.equal(bodies.find(b => b.spec.id === 'item:floor-item').spec.linearDamping, 1);
    assert.equal(bodies.find(b => b.spec.id === 'prop:crate').spec.linearDamping, 0.4);
  } finally { disposePhysics(s); }
});

test('P5 authoring is validated and match-pinned', async () => {
  const bad = arena();
  bad.motorSurfaces = [{ id: 'floor', x: 100, y: 100, w: 200, h: 200,
    priority: 1, speed: 1, traction: 1, braking: 1, drag: -0.1 }];
  await assert.rejects(createPhysicsGame(17, bad, content()), /floor drag/);
  const authored = arena();
  authored.physicsProps = [{ id: 'crate', profile: 'crate', x: 450, y: 200, angle: 0.2 }];
  const { s } = await game(authored);
  try {
    assert.throws(() => { s.map.physicsProps[0].x = 500; }, TypeError);
    assert.throws(() => { s.content.worldPhysics.loot.radius = 15; }, TypeError);
    assert.equal(s.map.physicsProps[0].x, 450);
    assert.equal(s.content.worldPhysics.loot.radius, 6);
  } finally { disposePhysics(s); }
});

test('repeated synchronization keeps stable body counts and identical physical traces', async () => {
  const runs = [];
  for (let n = 0; n < 2; n++) {
    const map = arena();
    map.physicsProps = [{ id: 'crate', profile: 'crate', x: 450, y: 200 }];
    map.items.push(item('loose', 'cell', { charge: 21 }));
    const { s, runtime } = await game(map);
    try {
      const initial = runtime.world.counts().dynamic;
      enqueuePhysicsImpulse(s, 'item:loose', { x: 100, y: 0 });
      const trace = [];
      for (let i = 0; i < 12; i++) {
        synchronizePhysics(s);
        step(s);
        assert.equal(runtime.world.counts().dynamic, initial);
        const frame = snapshot(s);
        trace.push({ item: frame.items.find(record => record.id === 'loose'),
          bodies: frame.bodies.map(body => ({ id: body.id, x: body.x, y: body.y, angle: body.angle })) });
      }
      assert.ok(trace.at(-1).item.x > trace[0].item.x);
      runs.push(trace);
    } finally { disposePhysics(s); }
  }
  assert.deepEqual(runs[0], runs[1]);
});
