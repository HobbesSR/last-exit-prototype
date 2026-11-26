import { renderedPlayerView as playerView } from './helpers/relational.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, setInput, snapshot, stateOf, step, synchronizePhysics,
  enqueuePhysicsImpulse } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { addItems, removeItem, unadmittedItems } from '../shared/simulation/ground-items.ts';
import { synchronize } from '../shared/simulation/game.ts';
import { openArea } from './helpers/arena.js';
import { identifyItems, itemId, itemLabel } from './helpers/item-identity.js';
import { now } from './helpers/scenario.js';

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
  // The rules are the core's (`rust/core/src/tick/tests/item_tests.rs`); this follows one cell through the started match.
  const map = arena(); map.items.push(item('cell-1', 'cell', { charge: 73, quality: 4 }));
  const { s, p } = await game(map);
  try {
    const cellBodies = frame => frame.bodies.filter(b => b.owner.kind === 'item' && b.owner.itemId === itemId(s, 'cell-1'));
    p.x = 300; p.y = 200;
    setInput(s, p.id, { seq: 1 }); step(s);
    assert.equal(stateOf(s).items.length, 0, 'the pickup took the whole record');
    assert.equal(cellBodies(snapshot(s)).length, 0, 'and its body');
    const carried = now(s, p).inventory[0];
    assert.equal(itemLabel(s, carried.instanceId), 'cell-1');
    assert.equal(carried.charge, 73);
    assert.equal(carried.quality, 4);
    setInput(s, p.id, { seq: 2, drop: true }); step(s);
    assert.equal(now(s, p).inventory[0], null);
    const dropped = stateOf(s).items[0];
    assert.equal(itemLabel(s, dropped.id), 'cell-1');
    assert.equal(dropped.charge, 73);
    assert.equal(dropped.quality, 4);
    assert.equal(cellBodies(snapshot(s)).length, 1, 'the drop has a body');
    step(s);
    const after = stateOf(s).items[0];
    assert.ok(Math.hypot(after.x - dropped.x, after.y - dropped.y) > 0, 'the dropped item moves');
    const frame = snapshot(s), [body] = cellBodies(frame);
    assert.equal(typeof body.id, 'number');
    assert.equal('x' in frame.items[0], false, 'only the body carries physical pose');
    assert.deepEqual({ x: after.x, y: after.y }, { x: body.x, y: body.y });
  } finally { disposePhysics(s); }
});

// A dropped stack leaves as single instances of one lineage, on the arranged inventory (docs/27.2 "Test API").
test('a dropped stack splits into single instances that keep its lineage', async () => {
  const { s, p } = await game();
  try {
    p.inventory[0] = carried('med-3', 'med', { count: 3, quality: 2 });
    identifyItems(s);
    setInput(s, p.id, { seq: 1, drop: true }); step(s);
    const pieces = stateOf(s).items.filter(i => itemLabel(s, i.lineageId) === 'med-3');
    assert.equal(pieces.length, 3);
    assert.ok(pieces.every(i => i.count === 1 && i.quality === 2));
    assert.equal(new Set(pieces.map(i => i.id)).size, 3);
  } finally { disposePhysics(s); }
});

test('stateOf hands out copies of the ground: editing a fresh drop changes no later read or frame (review 1105)', async () => {
  const { s, p } = await game();
  try {
    p.inventory = [carried('rifle-a', 'weapon', { weaponType: 'rifle', ammo: 7 }), null, null, null, null, null];
    identifyItems(s);
    setInput(s, p.id, { seq: 1, drop: true }); step(s);
    // Before any frame publishes it, the drop is the frame store's own record. The arena has no other loot.
    const read = () => stateOf(s).items.find(i => i.kind === 'weapon');
    const dropped = read(), kept = { ...dropped };
    assert.equal(kept.ammo, 7);
    Object.assign(dropped, { x: dropped.x + 100, ammo: 0 });
    assert.deepEqual(read(), kept, 'a fresh read keeps the core record');
    const framed = snapshot(s).items.find(i => i.kind === 'weapon');
    assert.equal(framed.ammo, 7, 'the frame keeps the core record');
    assert.ok(!('x' in framed) || framed.x === kept.x, 'the frame keeps its place');
  } finally { disposePhysics(s); }
});

test('a delayed view retains its captured item and body after the live item is consumed', async () => {
  const map = arena(); map.items.push(item('delayed', 'cell', { charge: 41, x: 300, y: 200 }));
  const { s, p } = await game(map);
  try {
    const owns = (view, id) => view.bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === id);
    // Walk east until the pickup consumes it; the frame before that is the delayed view.
    setInput(s, p.id, { seq: 1, x: 1 }); step(s);
    let captured = snapshot(s);
    for (let seq = 2; stateOf(s).items.length && seq < 200; seq++) {
      captured = snapshot(s);
      setInput(s, p.id, { seq, x: 1 }); step(s);
    }
    assert.equal(stateOf(s).items.length, 0, 'the live item was consumed');
    const id = itemId(s, 'delayed'), current = snapshot(s);
    assert.ok(playerView(s, captured, p.id).items.some(record => record.id === id), 'the captured item remains available to a delayed view');
    assert.ok(owns(playerView(s, captured, p.id), id), 'the captured body remains associated');
    assert.equal(playerView(s, current, p.id).items.some(record => record.id === id), false);
    assert.equal(owns(playerView(s, current, p.id), id), false);
  } finally { disposePhysics(s); }
});

// Retired with the rules they called (#1358): optional drops refused for lack of a body slot and mandatory death loot kept as
// logical overflow are the core's (`item_tests.rs`: `an_optional_drop_with_no_body_slot_or_no_clear_spot_is_refused_and_keeps_the_inventory`,
// `bodiless_death_drops_keep_value_and_are_claimable_next_tick`), and a full-inventory swap reserving its incoming body slot is
// `a_swap_reserves_its_body_slot_before_a_due_arrival`. A world filled, put to sleep or roped on the diagnostic engine is not
// loaded by the start, so neither case can be arranged on a started game.

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
