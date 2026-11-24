import { renderedPlayerView as playerView } from './helpers/relational.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, setInput, snapshot, step, synchronizePhysics,
  enqueuePhysicsImpulse } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups, dropInventorySlot } from '../shared/simulation/loot.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { eliminate } from '../shared/simulation/lifecycle.ts';
import { addItems, removeItem, unadmittedItems } from '../shared/simulation/ground-items.ts';
import { synchronize } from '../shared/simulation/game.ts';
import { openArea } from './helpers/arena.js';
import { identifyItems, itemId, itemLabel } from './helpers/item-identity.js';

const arena = () => ({ seed: 17, width: 800, height: 400,
  playableArea: openArea(800, 400, 100),
  buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [],
  entry: { x: 60, y: 200 }, exit: { x: 750, y: 200 }, spawns: [{ x: 120, y: 200 }] });
const content = () => ({ ...structuredClone(contentById('content-6')),
  roster: { contestants: ['A'], gladiators: [] }, discovery: false });
const item = (id, kind, fields = {}) => ({ id, kind, x: 300, y: 200, ...fields });
const carried = (id, kind, fields = {}) => ({ kind, instanceId: id, lineageId: id, ...fields });

async function game(map = arena(), profile = content()) {
  const s = await createGame(17, map, profile);
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

test('admission prioritizes launched ids, preserves reserve, and retries ordinary ids only until full (#863)', async () => {
  const profile = content();
  profile.worldPhysics.dropReserve = 1;
  const { s, runtime: r } = await game(arena(), profile);
  try {
    const count = fillDynamic(r);
    let blockedChecks = 0;
    const blocked = item('0-blocked', 'cell', { charge: 1 });
    Object.defineProperty(blocked, 'x', { enumerable: true, get() { blockedChecks++; return -100; } });
    blocked.id = itemId(s, blocked.id);
    const ordinary = ['z-launch', 'c', 'a', 'b-launch', ...Array.from({ length: 300 }, (_, i) => `tail-${i}`)]
      .map(id => item(id, 'cell', { charge: 1 }));
    for (const record of ordinary) record.id = itemId(s, record.id);
    addItems(s, blocked, ...ordinary);
    identifyItems(s);
    assert.equal(itemLabel(s, s.items[0].id), '0-blocked', 'setup normalization registers injected item labels');
    // Build the pending order once. Subsequent synchronizations must not retest every logical item for ownership.
    assert.equal([...unadmittedItems(s, r.items)].length, 305);
    for (let i = count - 4; i < count; i++) r.world.queueRemoveBody(`filler:${i}`);
    r.world.commitMutations();
    r.itemLaunches.set(itemId(s, 'z-launch'), { x: 12, y: 0 });
    r.itemLaunches.set(itemId(s, 'b-launch'), { x: 7, y: 0 });
    r.itemLaunches.set(itemId(s, '0-blocked'), { x: 5, y: 0 });
    const originalHas = r.items.has.bind(r.items);
    let ownershipChecks = 0;
    r.items.has = id => { ownershipChecks++; return originalHas(id); };
    // The body sync, whose item steps admit the items (`rust/core/src/boundary.rs`, one call since #1214 stage 6d.6).
    const synchronizePhysicalItems = (markTick) => synchronize(s, r, markTick);
    // Only the admission's reads count: setup's addItems reads each record once to write it through to the core's
    // ground store (#1214 stage 6d.1).
    blockedChecks = 0;
    synchronizePhysicalItems(19);
    assert.deepEqual(r.discontinuities.filter(d => d.kind === 'placed' && d.id.startsWith('item:')).map(d => d.id),
      ['item:b-launch', 'item:z-launch', 'item:a']);
    assert.ok(Math.abs(r.world.getTransform('item:b-launch').vx - 7) < 1e-5);
    assert.ok(Math.abs(r.world.getTransform('item:z-launch').vx - 12) < 1e-5);
    assert.equal(r.world.canAddBodies(1), true, 'ordinary admission leaves the drop reserve free');
    assert.equal(r.itemLaunches.size, 0);
    // Node reads no record during the admission: the core takes positions from its ground store and skips a launched
    // record in its ordinary walk (#1214 stage 6d.3, the sync's `items` step in `boundary.rs`). The blocked launch is not placed (above).
    assert.equal(blockedChecks, 0, 'the admission reads no record in JavaScript');
    assert.ok(ownershipChecks < 20, `only visited candidates check ownership (${ownershipChecks})`);
    const generation = r.world.getGeneration('item:a');
    removeItem(s, s.items.find(i => i.id === itemId(s, 'a')));
    synchronizePhysicalItems(20);
    assert.equal(r.world.hasBody('item:a'), false);
    assert.equal(r.world.hasBody('item:c'), true, 'the next ordinary id fills the released slot');
    assert.ok(r.discontinuities.some(d => d.id === 'item:a' && d.kind === 'removed' && d.generation === generation));
    assert.equal(r.world.hasBody('item:0-blocked'), false, 'a blocked first id does not prevent a later valid admission');
    // A failed launch stays among the records awaiting a body: the core's waiting list drops a record only when it is
    // admitted or leaves the ground (`World::stop_awaiting`, 6d.3), and JavaScript no longer reads it to retry.
    assert.equal(blockedChecks, 0);
  } finally { disposePhysics(s); }
});

test('admission packs the items awaiting a body in chunks, and reaches one behind more than a chunk of blocked ones (#1234)', async () => {
  const { s, runtime: r } = await game();
  try {
    // 70 items off the map lead the ID order: the first chunk (32) runs out with room left, so the next is packed.
    const blocked = Array.from({ length: 70 }, (_, i) => item(`a-${String(i).padStart(2, '0')}`, 'cell', { charge: 1, x: -100 }));
    const records = [...blocked, item('z', 'cell', { charge: 1 })];
    for (const record of records) record.id = itemId(s, record.id);
    addItems(s, ...records);
    identifyItems(s);
    synchronizePhysics(s);
    assert.equal(r.world.hasBody('item:z'), true);
    assert.equal(blocked.some(b => r.world.hasBody(`item:${itemLabel(s, b.id)}`)), false);
  } finally { disposePhysics(s); }
});

test('pickup and drop retain instance identity, quantity, charge, and physical pose', async () => {
  const { s, p, runtime } = await game();
  try {
    s.items.push(item('cell-1', 'cell', { charge: 73, quality: 4 }));
    identifyItems(s);
    synchronizePhysics(s);
    assert.equal(runtime.world.hasBody('item:cell-1'), true);
    p.x = 300; p.y = 200;
    automaticPickups(s, p, {});
    assert.equal(runtime.world.hasBody('item:cell-1'), false);
    assert.equal(itemLabel(s, p.inventory[0].instanceId), 'cell-1');
    assert.equal(p.inventory[0].charge, 73);
    assert.equal(p.inventory[0].quality, 4);
    assert.equal(dropInventorySlot(s, p, 0), true);
    assert.equal(p.inventory[0], null);
    assert.equal(itemLabel(s, s.items[0].id), 'cell-1');
    assert.equal(s.items[0].charge, 73);
    assert.equal(runtime.world.hasBody('item:cell-1'), true);
    const before = { ...s.items[0] };
    step(s);
    const after = s.items[0];
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0);
    const frame = snapshot(s), body = frame.bodies.find(b => b.owner.kind === 'item' && b.owner.itemId === itemId(s, 'cell-1'));
    assert.equal(typeof body.id, 'number');
    assert.equal('x' in frame.items[0], false, 'only the body carries physical pose');
    assert.deepEqual({ x: after.x, y: after.y }, { x: body.x, y: body.y });
    p.inventory[0] = carried('med-3', 'med', { count: 3, quality: 2 });
    identifyItems(s);
    assert.equal(dropInventorySlot(s, p, 0), true);
    assert.equal(s.items.filter(i => itemLabel(s, i.lineageId) === 'med-3').length, 3);
    assert.equal(s.items.filter(i => itemLabel(s, i.lineageId) === 'med-3').reduce((n, i) => n + i.count, 0), 3);
  } finally { disposePhysics(s); }
});

test('a delayed view retains its captured item and body after the live item is consumed', async () => {
  const map = arena(); map.items.push(item('delayed', 'cell', { charge: 41, x: 300, y: 200 }));
  const { s, p } = await game(map);
  try {
    p.x = 300; p.y = 200;
    synchronizePhysics(s);
    const captured = snapshot(s);
    assert.equal(s.items[0].id, itemId(s, 'delayed'), 'runtime ground carries the numeric item identity');
    assert.ok(playerView(s, captured, p.id).bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === itemId(s, 'delayed')));
    automaticPickups(s, p, {});
    const current = snapshot(s);
    assert.equal(s.items.length, 0, 'the live item was consumed');
    assert.ok(playerView(s, captured, p.id).items.some(record => record.id === itemId(s, 'delayed')), 'the captured item remains available to a delayed view');
    assert.ok(playerView(s, captured, p.id).bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === itemId(s, 'delayed')), 'the captured body remains associated');
    assert.equal(playerView(s, current, p.id).items.some(record => record.id === itemId(s, 'delayed')), false);
    assert.equal(playerView(s, current, p.id).bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === itemId(s, 'delayed')), false);
  } finally { disposePhysics(s); }
});

test('exhausted physical slots reject optional drops atomically but retain mandatory death loot', async () => {
  const { s, p, runtime } = await game();
  try {
    fillDynamic(runtime);
    assert.equal(runtime.world.canAddBodies(1), false);
    p.inventory[0] = carried('charged', 'cell', { charge: s.content.cellChargeTicks, quality: 3 });
    p.inventory[1] = carried('second', 'cell', { charge: 19, quality: 2 });
    identifyItems(s);
    const before = structuredClone({ inventory: p.inventory, items: s.items, itemSerial: s.itemSerial });
    assert.equal(dropInventorySlot(s, p, 0), false);
    assert.deepEqual({ inventory: p.inventory, items: s.items, itemSerial: s.itemSerial }, before);
    eliminate(s, p, null);
    const fallen = s.items.find(i => i.id === itemId(s, 'charged'));
    assert.equal(fallen.charge, s.content.cellChargeTicks);
    assert.equal(fallen.quality, 3);
    assert.equal(s.items.length, 2);
    assert.equal(Number(runtime.world.hasBody('item:charged')) + Number(runtime.world.hasBody('item:second')), 0,
      'reserved roster capacity leaves overflow as logical loot');
    assert.ok(p.inventory.every(i => i === null));
  } finally { disposePhysics(s); }
});

test('full-inventory E swap uses the incoming body slot and removes a sleeping pickup with its joint', async () => {
  // Keep the incoming pickup inside pickup reach (45) and clear of the actor's body + loot radius so admission succeeds.
  const { s, p, runtime } = await game(arena(), content());
  try {
    for (let i = 0; i < 6; i++) p.inventory[i] = carried(`held-${i}`, 'cell', { charge: i + 1 });
    s.items.push(item('incoming', 'cell', { x: p.x + 35, charge: 79 }));
    identifyItems(s);
    synchronizePhysics(s);
    runtime.world.queueAddConstraint({ id: 'item-rope', a: 'item:incoming', b: 'actor:c0', maxDistance: 40 });
    runtime.world.commitMutations();
    for (let i = 0; i < 240 && !runtime.world.getTransform('item:incoming').sleeping; i++) runtime.world.step();
    assert.equal(runtime.world.getTransform('item:incoming').sleeping, true);
    fillDynamic(runtime);
    assert.equal(runtime.world.canAddBodies(1), false);
    interact(s, p);
    assert.equal(itemLabel(s, p.inventory[0].instanceId), 'incoming');
    assert.equal(p.inventory[0].charge, 79);
    assert.equal(runtime.world.hasBody('item:incoming'), false);
    assert.equal(runtime.world.counts().constraints, 0);
    assert.equal(runtime.world.hasBody('item:held-0'), true);
    assert.equal(s.items.find(i => i.id === itemId(s, 'held-0')).charge, 1);
  } finally { disposePhysics(s); }
});

test('world physics authoring is validated and match-pinned', async () => {
  const bad = arena();
  bad.motorSurfaces = [{ id: 'floor', x: 100, y: 100, w: 200, h: 200,
    priority: 1, speed: 1, traction: 1, braking: 1, drag: -0.1 }];
  await assert.rejects(createGame(17, bad, content()), /floor drag/);
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
