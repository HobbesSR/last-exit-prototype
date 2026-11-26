import { startGame } from '../shared/simulation/tick.ts';
import { renderedSnapshot } from './helpers/relational.js';
import { renderedPlayerView as playerView } from './helpers/relational.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createGameRecord, createGame, disposePhysics, PHYSICS_VERSION, setInput, stateOf, step as stepRaw, snapshot as snapshotRaw, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { allocateItemId, commitItemAllocation, forkItemAllocation, itemIdForLabel, itemLabel, registerItemLabel } from '../shared/item-instances.ts';
import { SCHEMA, minimumReaderForMatch, recordingFit } from '../shared/recording.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { openArea } from './helpers/arena.js';
import { readArchive } from './helpers/recordings.js';
import { identifyItems, registeredItemId as itemId } from './helpers/item-identity.js';
import { now } from './helpers/scenario.js';

// No generated map, bots or hazards: only the world/inventory transition is under test.
const arena = () => ({ width: 600, height: 400,
  playableArea: openArea(600, 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [],
  buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (capacity = 4096) => ({ ...structuredClone(contentById('content-7')),
  roster: { contestants: ['A', 'B'], gladiators: [] }, itemInstances: { groundCapacity: capacity }, discovery: false });
/** A physics match on the arena, disposed when test `t` ends. */
async function fixture(t, capacity, map = arena()) {
  const s = await createGame(17, map, content(capacity));
  t.after(() => disposePhysics(s));
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0], q: s.players[1] };
}
const ground = (id, kind, fields = {}) => ({ id, kind, x: 120, y: 200, ...fields });
const step = s => { identifyItems(s); return stepRaw(s); };
const snapshot = s => { identifyItems(s); return snapshotRaw(s); };

test('item instances are required on match content and initialize a counter without consuming RNG', async t => {
  assert.throws(() => createGameRecord(17, arena(), { ...content(), itemInstances: undefined }), /item instances required/);
  const { s } = await fixture(t);
  assert.equal(s.version, PHYSICS_VERSION);
  assert.equal(s.itemSerial, 1, 'the internal numeric allocator starts with the first positive identity');
  assert.equal(s.scatterSerial, 0);
  assert.equal(snapshot(s).itemSerial, s.itemSerial);
});

test('label registration is numeric, does not spend scatter phases, and staged labels roll back until committed', async t => {
  const { s, p } = await fixture(t);
  const root = registerItemLabel(s, 'test-root');
  assert.equal(typeof root, 'number');
  assert.ok(root > 0);
  const scatter = s.scatterSerial;
  const baseNext = s.itemSerial;
  const abandoned = forkItemAllocation(s);
  const rolledBack = registerItemLabel(abandoned, 'discarded-child');
  assert.equal(itemIdForLabel(s, 'discarded-child'), undefined, 'uncommitted labels stay private to the staged game');
  assert.throws(() => itemLabel(s, rolledBack), /Unregistered item identity/);
  assert.equal(s.itemSerial, baseNext);
  assert.equal(s.scatterSerial, scatter, 'metadata registration never advances legacy scatter scheduling');
  const committed = forkItemAllocation(s);
  const child = registerItemLabel(committed, 'committed-child');
  commitItemAllocation(s, committed);
  assert.equal(itemIdForLabel(s, 'committed-child'), child);
  assert.equal(itemLabel(s, root), 'test-root');
  assert.equal(s.scatterSerial, scatter);
  p.inventory[0] = { kind: 'cell', charge: 1, instanceId: 'live-child', lineageId: 'test-root' };
  identifyItems(s);
  p.inventory[0] = null; // The root disappears from live items but stays reserved in the registry.
  assert.equal(itemLabel(s, root), 'test-root');
  assert.notEqual(allocateItemId(s), root);
});

// The ground-to-carried half of this (a partial take leaves the remainder, an equal quality merges into the target) is the
// core's: `partial_stacks_fill_remaining_capacity_in_claim_order`.
// Same-quality merges keep the target's identity and different qualities swap without blending: the core's, in `rust/core/src/tick/tests/item_tests.rs`,
// `slot_moves_merge_compatible_stacks_swap_otherwise_follow_selection_and_reject_invalid_requests`.

test('E swap is atomic at capacity and a successful swap cannot repick its own drop this tick', async t => {
  for (const capacity of [1, 2]) {
    const { s, p } = await fixture(t, capacity);
    p.inventory[0] = { kind: 'med', count: 2, instanceId: 'owned-0', lineageId: 'owned-0' };
    for (let i = 1; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i + 10, instanceId: `owned-${i}`, lineageId: `owned-${i}` };
    const incoming = ground('incoming', 'cell', { charge: 73 });
    s.items.push(incoming);
    identifyItems(s);
    synchronizePhysics(s); // Admit the staged pickup before a split-stack swap commits its outgoing copies.
    const before = structuredClone({ inventory: p.inventory, items: s.items, itemSerial: s.itemSerial });
    setInput(s, p.id, { seq: 1, interact: true }); step(s);
    const after = stateOf(s), me = now(s, p);
    if (capacity === 1) {
      assert.deepEqual({ inventory: me.inventory, items: after.items, itemSerial: snapshot(s).itemSerial }, before);
    } else {
      assert.equal(me.inventory[0].instanceId, itemId(s, 'incoming'));
      assert.equal(me.inventory[0].charge, 73);
      assert.equal(after.items.length, 2);
      assert.ok(after.items.some(i => i.id === itemId(s, 'owned-0')));
      assert.ok(after.items.every(i => i.kind === 'med' && i.count === 1 && i.droppedBy === p.id && i.pickupAfter > after.tick));
    }
  }
});

test('snapshot is detached; carried identity and the counter stay private', async t => {
  const { s, p, q } = await fixture(t);
  p.inventory[0] = { kind: 'cell', charge: 63, instanceId: 'cell-1', lineageId: 'root-1', quality: 5 };
  q.x = 130; q.y = 200;
  const frame = snapshot(s), own = playerView(s, frame, p.id), other = playerView(s, frame, q.id);
  assert.equal(frame.itemSerial, s.itemSerial, 'the outward compatibility field stays on the legacy schedule');
  assert.equal(own.itemSerial, undefined);
  assert.equal(other.itemSerial, undefined);
  // The owner sees what it carries, but not its instance identity, which no client reads (#1131 stage 3).
  const carried = own.players.find(v => v.id === p.id).inventory[0];
  assert.equal(carried.quality, 5);
  for (const field of ['instanceId', 'lineageId']) assert.equal(Object.hasOwn(carried, field), false, `${field} is not projected`);
  assert.equal(typeof p.inventory[0].instanceId, 'number');
  assert.equal(typeof p.inventory[0].lineageId, 'number');
  assert.equal(Object.hasOwn(other.players.find(v => v.id === p.id), 'inventory'), false);
  frame.players[0].inventory[0].charge = 0;
  assert.equal(p.inventory[0].charge, 63);
});

test('identical traces yield identical identities, counters, quantities and snapshots', async t => {
  async function trace() {
    const { s, p } = await fixture(t);
    s.items.push(ground('med', 'med', { count: 2 }), ground('cell', 'cell', { charge: 41, x: 300 }));
    step(s);
    setInput(s, p.id, { seq: 1, slot: 0, drop: true }); step(s);
    // What the match did (docs/27.2 "Test API"); the record's rng and serial no longer follow it.
    const frame = snapshot(s);
    return { inventory: now(s, p).inventory, items: stateOf(s).items, itemSerial: frame.itemSerial, frame };
  }
  assert.deepEqual(await trace(), await trace());
});

test('recording roundtrip and backward seeks retain exact item-instance frames', async t => {
  const map = arena();
  map.items.push(ground('med-root', 'med', { count: 3 }),
    ground('rifle-root', 'weapon', { weaponType: 'rifle', ammo: 7, quality: 2 }),
    ground('cell-root', 'cell', { charge: 100 }));
  const s = await createGame(17, map, content());
  t.after(() => disposePhysics(s));
  for (const player of s.players) { player.bot = false; player.input = {}; }
  const p = s.players[0], chunks = [];
  const header = { id: 'item-roundtrip', version: s.version, contentId: s.content.id,
    schema: SCHEMA, minSchema: minimumReaderForMatch(), seed: s.seed,
    hz: 20, createdAt: 1, map: structuredClone(map) };
  assert.equal(header.minSchema, 20, 'relational records need a schema-20 reader');
  assert.equal(recordingFit(header), 'ok');
  assert.equal(recordingFit({ ...header, schema: 10, minSchema: 10 }), 'ok');
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => assert.fail(error.message) });
  let finished = false;
  t.after(() => { if (!finished) writer.abort(); });
  const frames = [];
  const retain = () => {
    const frame = snapshot(s);
    frames.push(JSON.parse(JSON.stringify(frame))); // Expected wire value; JSON omits undefined input fields.
    assert.equal(writer.append(frame, []), true);
  };
  startGame(s); retain();
  step(s); retain();
  const byId = rows => rows.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(byId(now(s, p).inventory.filter(Boolean).map(i => [i.instanceId, i.lineageId, i.quality])),
    byId([['med-root', 'med-root', undefined], ['rifle-root', 'rifle-root', 2], ['cell-root', 'cell-root', undefined]].map(([id, lineage, quality]) => [itemId(s, id), itemId(s, lineage), quality])));
  const press = input => { assert.ok(setInput(s, p.id, { seq: p.lastSeq + 1, ...input })); step(s); retain(); };
  for (let slot = 0; slot < 3; slot++) {
    if (slot !== now(s, p).selectedSlot) press({ slot });
    press({ drop: true });
  }
  const finalItems = frames.at(-1).items;
  assert.equal(finalItems.length, 5, 'the three-count utility stack drops as three items');
  assert.equal(finalItems.filter(i => i.kind === 'med').reduce((count, i) => count + i.count, 0), 3);
  assert.equal(finalItems.find(i => i.id === itemId(s, 'rifle-root')).ammo, 7);
  assert.equal(finalItems.find(i => i.id === itemId(s, 'cell-root')).charge, 100);
  assert.ok(finalItems.every(i => i.lineageId));
  assert.equal(finalItems.find(i => i.kind === 'weapon').quality, 2);
  assert.ok(frames.every(frame => Number.isSafeInteger(frame.itemSerial)));

  await writer.finish({ ticks: s.tick, escaped: 0 });
  finished = true;
  const archive = readArchive(chunks);
  assert.equal(recordingFit(archive), 'ok');
  assert.deepEqual(archive.frames.map(frame => frame.state), frames);
  const timeline = createReplayTimeline(archive);
  for (const tick of [frames.length - 1, 1, 3, 0, 2, 4]) {
    assert.equal(timeline.at(tick).frameTick, tick);
    assert.deepEqual(timeline.at(tick).state, renderedSnapshot(map, frames[tick]));
  }
});
