import { renderedPlayerView as playerView, renderedSnapshot } from './helpers/relational.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, createGame, disposePhysics, PHYSICS_VERSION, setInput, stateOf, step as stepRaw, snapshot as snapshotRaw } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { queueInput } from '../shared/simulation/input.ts';
import { Writable } from 'node:stream';
import { SCHEMA, minimumReaderForMatch, recordingFit } from '../shared/recording.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { rounds } from './helpers/rounds.js';
import { openArea } from './helpers/arena.js';
import { readArchive } from './helpers/recordings.js';
import { identifyItems, registeredItemId as itemId, itemLabel } from './helpers/item-identity.js';
import { now } from './helpers/scenario.js';

const AMMO = contentById('content-ammo-1');
const arena = () => ({ width: 600, height: 400,
  playableArea: openArea(600, 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [],
  buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (id = 'content-ammo-1') => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
/** A physics match on the arena, disposed when test `t` ends. */
async function fixture(t, id) {
  const s = await createGame(17, arena(), content(id));
  t.after(() => disposePhysics(s));
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0], q: s.players[1] };
}
const pistol = (ammo, id = 'gun') => ({ kind: 'weapon', weaponType: 'pistol', ammo, instanceId: id, lineageId: id });
let seq = 0;
const step = s => { identifyItems(s); return stepRaw(s); };
const snapshot = s => { identifyItems(s); return snapshotRaw(s); };
const tick = (s, p, input = {}) => { setInput(s, p.id, { seq: ++seq, ...input }); step(s); };

test('reloading is opt-in on the one physics rules version, requires item instances and leaves loot-1 without reserves', async t => {
  const { s, p } = await fixture(t);
  assert.equal(s.version, PHYSICS_VERSION);
  assert.deepEqual(p.reserves, { pistol: 0, rifle: 0, shell: 0 });
  const { s: loot } = await fixture(t, 'content-loot-1');
  assert.equal(loot.version, PHYSICS_VERSION);
  assert.equal(loot.players[0].reserves, undefined);
  assert.throws(() => createGameRecord(17, arena(), { ...content(), itemInstances: undefined }), /item instances required/);
});

test('gladiators carry no reserves', () => {
  // Setup needs no engine, so the shared constructor stands in for a match.
  const s = createGameRecord(17, arena(), { ...content(), roster: { contestants: ['A'], gladiators: [{ name: 'G', kit: 'warden' }] } });
  assert.equal(s.players.find(q => q.role === 'gladiator').reserves, undefined);
});

test('spawn migration splits each map weapon into a full magazine and an ammo pickup, never duplicating', () => {
  const map = arena();
  map.items.push({ id: 'kit', kind: 'weapon', weaponType: 'pistol', x: 140, y: 200 },
    { id: 'rifle', kind: 'weapon', weaponType: 'rifle', ammo: 90, x: 300, y: 120 },
    { id: 'shotty', kind: 'weapon', weaponType: 'scattergun', ammo: 4, x: 300, y: 300 });
  const s = createGameRecord(17, map, content());
  const byId = Object.fromEntries(s.items.map(item => [itemLabel(s, item.id), item]));
  assert.deepEqual([byId.kit.ammo, byId.rifle.ammo, byId.shotty.ammo], [12, 30, 4]);
  const piles = s.items.filter(item => item.kind === 'ammo');
  assert.deepEqual(piles.map(item => [item.family, item.count]), [['pistol', 36], ['rifle', 60]]);
  assert.ok(piles.every(item => typeof item.id === 'number' && item.id > 0 && itemLabel(s, item.id).startsWith('instance-') && item.lineageId === item.id));
  // Totals are exactly today's pickup rounds: 48 pistol, 90 rifle, 4 shells.
  assert.deepEqual(['pistol', 'rifle', 'shell'].map(family => rounds(s, family)), [48, 90, 4]);
});

test('a completed reload transfers min(missing, reserve) once and keeps unused loaded rounds', async t => {
  const { s, p } = await fixture(t);
  p.inventory[0] = pistol(5); p.reserves.pistol = 20;
  tick(s, p, { reload: true });
  assert.ok(now(s, p).reload);
  for (let i = 1; i < AMMO.reloading.weapons.pistol.reloadTicks; i++) tick(s, p, { attack: true, reload: true });
  assert.equal(stateOf(s).projectiles.length, 0, 'attack is blocked while reloading');
  assert.deepEqual([now(s, p).inventory[0].ammo, now(s, p).reserves.pistol], [5, 20]);
  tick(s, p);
  assert.deepEqual([now(s, p).inventory[0].ammo, now(s, p).reserves.pistol, now(s, p).reload], [12, 13, null]);
  for (let i = 0; i < 25; i++) tick(s, p);
  assert.deepEqual([now(s, p).inventory[0].ammo, now(s, p).reserves.pistol], [12, 13], 'transferred once; no auto-reload');

  const short = await fixture(t);
  short.p.inventory[0] = pistol(5); short.p.reserves.pistol = 3;
  tick(short.s, short.p, { reload: true });
  for (let i = 0; i < 20; i++) tick(short.s, short.p);
  assert.deepEqual([now(short.s, short.p).inventory[0].ammo, now(short.s, short.p).reserves.pistol], [8, 0], 'a short reserve loads what it has');
  tick(short.s, short.p, { reload: true });
  assert.equal(now(short.s, short.p).reload, null, 'nothing to load: no reload starts');
});

test('movement continues while reloading, and the reload completes on the move', async t => {
  const { s, p } = await fixture(t);
  p.inventory[0] = pistol(0); p.reserves.pistol = 30;
  const x = p.x;
  tick(s, p, { reload: true, x: 1 });
  for (let i = 0; i < 20; i++) tick(s, p, { x: 1 });
  assert.ok(now(s, p).x > x + 50, `moved ${now(s, p).x - x}`);
  assert.deepEqual([now(s, p).inventory[0].ammo, now(s, p).reserves.pistol], [12, 18]);
});

test('switching slots interrupts a reload and dropping ammo publishes the reserve change and pickup', async t => {
  const { s, p } = await fixture(t);
  p.inventory[0] = pistol(5);
  p.inventory[1] = pistol(12, 'spare');
  p.reserves.pistol = 20;
  tick(s, p, { reload: true });
  assert.ok(snapshot(s).players[0].reload);
  tick(s, p, { slot: 1, dropAmmo: { family: 'pistol', count: 4 } });
  const frame = snapshot(s), owner = frame.players[0], pile = frame.items.find(item => item.kind === 'ammo');
  assert.equal(owner.reload, null);
  assert.equal(owner.inventory[0].ammo, 5);
  assert.equal(owner.reserves.pistol, 16);
  assert.deepEqual([pile.family, pile.count, pile.droppedBy], ['pistol', 4, p.id]);
});

// Retired with the rules they called (#1358); the core holds each (`rust/core/src/tick/tests/item_tests.rs`):
// - death drops every reserve family and the magazines, and ends a reload: `death_drops_every_reserve_family_and_the_magazines_and_ends_a_reload`;
// - ammo fills a reserve with six full slots, and a full reserve leaves the pile: `ammo_fills_a_reserve_with_six_full_slots_and_a_full_reserve_leaves_the_pile`;
// - a matching weapon feeds its family reserve and its magazine never merges: `duplicate_magazines_and_loose_ammo_fill_reserves_without_changing_loaded_rounds`.
// An ammo family outside the three is a type error in the core, so the "laser" refusal has no equivalent.

test('wire input: L2 commands are validated and absent unless sent, so older inputs keep their shape', () => {
  const p = { inputQueue: [], receivedSeq: -1 };
  const plain = queueInput(p, { seq: 1, x: 1 }, 0);
  assert.equal(Object.hasOwn(plain, 'reload'), false);
  assert.equal(Object.hasOwn(plain, 'dropAmmo'), false);
  assert.equal(queueInput(p, { seq: 2, reload: 'yes' }, 0).reload, undefined);
  assert.equal(queueInput(p, { seq: 3, reload: true }, 0).reload, true);
  for (const [n, dropAmmo] of [[4, { family: 'laser', count: 1 }], [5, { family: 'rifle', count: 0 }], [6, { family: 'rifle', count: 1.5 }], [7, { family: 'rifle', count: 1e6 }], [8, 'rifle']]) {
    assert.equal(queueInput(p, { seq: n, dropAmmo }, 0).dropAmmo, undefined, JSON.stringify(dropAmmo));
  }
  assert.deepEqual(queueInput(p, { seq: 9, dropAmmo: { family: 'shell', count: 6, extra: 1 } }, 0).dropAmmo, { family: 'shell', count: 6 });
});

test('the owner sees reserves and reload progress; other players and older content do not', async t => {
  const { s, p, q } = await fixture(t);
  q.x = p.x + 40;
  p.inventory[0] = pistol(1); p.reserves.pistol = 9;
  tick(s, p, { reload: true });
  const reload = now(s, p).reload;
  const frame = snapshot(s), own = playerView(s, frame, p.id), other = playerView(s, frame, q.id);
  assert.deepEqual(own.players.find(r => r.id === p.id).reserves, { pistol: 9, rifle: 0, shell: 0 });
  // Progress names the reloading slot; the item's identity is not sent (#1131 stage 3).
  assert.deepEqual(own.players.find(r => r.id === p.id).reload, { slot: 0, until: reload.until });
  const seen = other.players.find(r => r.id === p.id);
  assert.equal(seen.reserves, undefined); assert.equal(seen.reload, undefined);
  // Ground ammo keeps its family on the live wire, as in recorded frames. Frames come from the core, so the box is
  // given to the projection on a frame rather than arranged on the game mid-match. An edited frame is not the core's to
  // decide, so `playerView` projects it by the rules (#1357, review 1134).
  const id = Math.max(0, ...frame.items.map(item => item.id)) + 1;
  const boxed = { ...frame, items: [...frame.items, { id, kind: 'ammo', family: 'shell', count: 4, x: q.x, y: q.y }] };
  const box = playerView(s, boxed, q.id).items.find(item => item.id === id);
  assert.equal(box.family, 'shell');
  const plain = createGameRecord(17, arena(), content('content-7'));
  assert.equal(Object.hasOwn(snapshot(plain).players[0], 'reserves'), false);
});

// A full-inventory E that cannot take a whole duplicate weapon, with its reserve under reloading, swaps nothing: the core's
// `an_interaction_never_swaps_out_the_selected_item_for_a_duplicate_firearm`.

test('current recordings keep reserves, reloads and ammo pickups exactly through backward seeks', async t => {
  const { s, p } = await fixture(t);
  p.inventory[0] = pistol(2); p.reserves.pistol = 30;
  const chunks = [], frames = [];
  const header = { id: 'ammo-roundtrip', version: s.version, contentId: s.content.id, schema: SCHEMA,
    minSchema: minimumReaderForMatch(), seed: s.seed, hz: 20, createdAt: 1, map: structuredClone(s.map) };
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => assert.fail(error.message) });
  const retain = () => { const frame = snapshot(s); frames.push(JSON.parse(JSON.stringify(frame))); assert.equal(writer.append(frame, []), true); };
  retain();
  tick(s, p, { reload: true }); retain();
  for (let i = 0; i < 20; i++) step(s);
  retain();
  tick(s, p, { dropAmmo: { family: 'pistol', count: 8 } }); retain();
  assert.deepEqual([frames[1].players[0].reload.instanceId, frames[2].players[0].inventory[0].ammo, frames[3].players[0].reserves.pistol], [itemId(s, 'gun'), 12, 12]);
  assert.deepEqual(frames[3].items.map(item => [item.kind, item.family, item.count]), [['ammo', 'pistol', 8]]);
  await writer.finish({ ticks: s.tick, escaped: 0 });
  const archive = readArchive(chunks);
  assert.equal(recordingFit(archive), 'ok');
  assert.deepEqual(archive.frames.map(frame => frame.state), frames);
  const timeline = createReplayTimeline(archive);
  for (const at of [3, 0, 2, 1, 3]) assert.deepEqual(timeline.at(frames[at].tick).state, renderedSnapshot(s.map, frames[at]));
});
