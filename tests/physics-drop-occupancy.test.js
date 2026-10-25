import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { dropInventorySlot, planDrop, scatterPoint } from '../shared/simulation/loot.ts';
import { interact } from '../shared/simulation/interactions.ts';

const map = (props = []) => ({ seed: 448, width: 800, height: 800,
  playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], physicsProps: props,
  entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns: [{ x: 120, y: 400 }] });
const content = () => ({ ...structuredClone(contentById('content-physics-5')), dynamicNavigation: true,
  roster: { contestants: ['A'], gladiators: [] }, discovery: false });
const carried = id => ({ kind: 'cell', charge: 37, instanceId: id, lineageId: id });

test('P8 scatter avoids active actor footprints and rotated prop colliders', async () => {
  const s = await createPhysicsGame(448, map([{ id: 'crate', profile: 'crate', x: 350, y: 400, angle: Math.PI / 4 }]), content());
  try {
    const r = physicsRuntime(s), origin = { x: 300, y: 400 };
    const first = { x: 336, y: 400 };
    assert.equal(r.world.overlapsProp(first.x, first.y, s.content.worldPhysics.loot.radius), true);
    const byCrate = scatterPoint(s, origin, 0, []);
    assert.ok(byCrate);
    assert.notDeepEqual(byCrate, first);
    assert.equal(r.world.overlapsProp(byCrate.x, byCrate.y, s.content.worldPhysics.loot.radius), false);

    // Move the actor to the first otherwise legal point in a clear region.
    const actor = s.players[0], actorOrigin = { x: 500, y: 500 };
    actor.x = actorOrigin.x + 36; actor.y = actorOrigin.y;
    synchronizePhysics(s);
    const byActor = scatterPoint(s, actorOrigin, 0, []);
    assert.ok(byActor);
    assert.notDeepEqual(byActor, { x: actor.x, y: actor.y });
    assert.ok(Math.hypot(byActor.x - actor.x, byActor.y - actor.y)
      >= s.content.worldPhysics.loot.radius + s.content.actorPhysics.geometry[actor.role].bodyRadius);
  } finally { disposePhysics(s); }
});

test('crowded optional physical drop refuses atomically without consuming inventory or IDs', async () => {
  const s = await createPhysicsGame(448, map(), content());
  try {
    const p = s.players[0], r = physicsRuntime(s);
    p.inventory[0] = carried('held');
    let count = 0;
    while (r.world.canAddBodies(1)) r.world.queueAddBody({ id: `crowd:${count++}`, kind: 'prop',
      shape: { kind: 'circle', radius: 2 }, x: 700, y: 700 });
    r.world.commitMutations();
    const before = { serial: s.itemSerial, items: s.map.items.length, bodyCount: r.world.counts().dynamic };
    assert.ok(planDrop(s, p, p.inventory[0]));
    const synchronize = r.synchronize;
    r.synchronize = () => { throw new Error('planning must not synchronize the runtime'); };
    try { assert.equal(dropInventorySlot(s, p, 0), false); }
    finally { r.synchronize = synchronize; }
    assert.deepEqual(p.inventory[0], carried('held'));
    assert.equal(s.itemSerial, before.serial);
    assert.equal(s.map.items.length, before.items);
    assert.equal(r.world.counts().dynamic, before.bodyCount);
  } finally { disposePhysics(s); }
});

test('P8 full-inventory swap stages its serial but still checks rotated prop occupancy', async () => {
  const s = await createPhysicsGame(448, map([{ id: 'crate', profile: 'crate', x: 600, y: 600, angle: Math.PI / 4 }]), content());
  try {
    const p = s.players[0], r = physicsRuntime(s);
    p.bot = false; p.x = 300; p.y = 400;
    synchronizePhysics(s);
    for (let i = 0; i < p.inventory.length; i++) p.inventory[i] = carried(`held-${i}`);
    p.selectedSlot = 0;
    s.map.items.push({ id: 'incoming', lineageId: 'incoming', kind: 'cell', charge: 91, x: 300, y: 420 });
    synchronizePhysics(s);
    const phase = s.itemSerial ?? 0, first = { x: p.x + Math.cos(phase * 2.39996) * 36,
      y: p.y + Math.sin(phase * 2.39996) * 36 };
    r.world.setTransform('prop:crate', { ...first, angle: Math.PI / 4 });
    assert.equal(r.world.overlapsProp(first.x, first.y, s.content.worldPhysics.loot.radius), true);
    const serial = s.itemSerial;
    interact(s, p);
    assert.equal(p.inventory[0].instanceId, 'incoming');
    assert.equal(s.itemSerial, serial, 'a whole-instance swap allocates no ID');
    const outgoing = s.map.items.find(item => item.id === 'held-0');
    assert.ok(outgoing);
    assert.notDeepEqual({ x: outgoing.x, y: outgoing.y }, first);
    assert.equal(r.world.overlapsProp(outgoing.x, outgoing.y, s.content.worldPhysics.loot.radius), false);
    assert.equal(r.world.hasBody('item:held-0'), true);
  } finally { disposePhysics(s); }
});

test('mandatory fallback remains logical and pickable, then admits a body after actor clears it', async () => {
  const s = await createPhysicsGame(448, map(), content());
  try {
    const p = s.players[0], r = physicsRuntime(s);
    const carriedItem = { ...carried('mandatory'), charge: 71 };
    const blockers = Array.from({ length: 180 }, (_, j) => {
      const angle = ((s.itemSerial ?? 0) + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      return { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
    });
    const plan = planDrop(s, p, carriedItem, true, blockers);
    assert.ok(plan);
    const item = plan.records[0];
    assert.deepEqual({ x: item.x, y: item.y }, { x: p.x, y: p.y });
    s.map.items.push(item);
    synchronizePhysics(s);
    assert.equal(r.world.hasBody('item:mandatory'), false);
    assert.deepEqual(s.map.items[0], item);
    p.x = 300; p.y = 400;
    synchronizePhysics(s);
    assert.equal(r.world.hasBody('item:mandatory'), true);
    assert.equal(s.map.items[0].charge, 71);
  } finally { disposePhysics(s); }
});
