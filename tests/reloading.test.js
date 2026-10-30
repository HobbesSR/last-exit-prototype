import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createGame, createPhysicsGame, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { collectAmmo, collectInstanceEquipment } from '../shared/equipment.ts';
import { automaticPickups, dropInventorySlot } from '../shared/simulation/loot.ts';
import { eliminate } from '../shared/simulation/lifecycle.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { queueInput } from '../shared/simulation/input.ts';
import { Writable } from 'node:stream';
import { SCHEMA, minimumReaderForMatch, recordingFit } from '../shared/recording.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';

const AMMO = contentById('content-ammo-1');
const arena = () => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (id = 'content-ammo-1') => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
function fixture(map) {
  const s = createGame(17, map ?? arena(), content());
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0], q: s.players[1] };
}
const pistol = (ammo, id = 'gun') => ({ kind: 'weapon', weaponType: 'pistol', ammo, instanceId: id, lineageId: id });
let seq = 0;
const tick = (s, p, input = {}) => { setInput(s, p.id, { seq: ++seq, ...input }); step(s); };
/** Every round of a family in the match: ground weapons and pickups, magazines and reserves. */
function rounds(s, family) {
  const weaponFamily = type => s.content.reloading.weapons[type].family;
  let total = 0;
  for (const item of s.map.items) {
    if (item.kind === 'ammo' && item.family === family) total += item.count;
    if (item.kind === 'weapon' && weaponFamily(item.weaponType ?? 'pistol') === family) total += item.ammo;
  }
  for (const p of s.players) {
    total += p.reserves?.[family] ?? 0;
    for (const item of p.inventory ?? []) if (item?.kind === 'weapon' && weaponFamily(item.weaponType) === family) total += item.ammo;
  }
  return total;
}

test('L2 is opt-in, versioned, requires L0 and leaves loot-1 without reserves', () => {
  const { s, p } = fixture();
  assert.equal(s.version, 'last-exit-0.8-ammo-1');
  assert.deepEqual(p.reserves, { pistol: 0, rifle: 0, shell: 0 });
  assert.equal(s.players.find(q => q.role === 'gladiator')?.reserves, undefined);
  const loot = createGame(17, arena(), content('content-loot-1'));
  assert.equal(loot.version, 'last-exit-0.8-loot-1');
  assert.equal(loot.players[0].reserves, undefined);
  assert.throws(() => createGame(17, arena(), { ...content(), itemInstances: undefined }), /requires L0/);
});

test('the physics tick refuses L2 content rather than silently never reloading', async () => {
  const physical = { ...contentById('content-physics-5'), reloading: contentById('content-ammo-1').reloading };
  await assert.rejects(createPhysicsGame(17, arena(), physical), /no physics tick/);
});

test('spawn migration splits each map weapon into a full magazine and an ammo pickup, never duplicating', () => {
  const map = arena();
  map.items.push({ id: 'kit', kind: 'weapon', weaponType: 'pistol', x: 140, y: 200 },
    { id: 'rifle', kind: 'weapon', weaponType: 'rifle', ammo: 90, x: 300, y: 120 },
    { id: 'shotty', kind: 'weapon', weaponType: 'scattergun', ammo: 4, x: 300, y: 300 });
  const s = createGame(17, map, content());
  const byId = Object.fromEntries(s.map.items.map(item => [item.id, item]));
  assert.deepEqual([byId.kit.ammo, byId.rifle.ammo, byId.shotty.ammo], [12, 30, 4]);
  const piles = s.map.items.filter(item => item.kind === 'ammo');
  assert.deepEqual(piles.map(item => [item.family, item.count]), [['pistol', 36], ['rifle', 60]]);
  assert.ok(piles.every(item => item.id.startsWith('instance-') && item.lineageId === item.id));
  // Totals are exactly today's pickup rounds: 48 pistol, 90 rifle, 4 shells.
  assert.deepEqual(['pistol', 'rifle', 'shell'].map(family => rounds(s, family)), [48, 90, 4]);
});

test('a completed reload transfers min(missing, reserve) once and keeps unused loaded rounds', () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(5); p.reserves.pistol = 20;
  tick(s, p, { reload: true });
  assert.ok(p.reload);
  for (let i = 1; i < AMMO.reloading.weapons.pistol.reloadTicks; i++) tick(s, p, { attack: true, reload: true });
  assert.equal(s.projectiles.length, 0, 'attack is blocked while reloading');
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol], [5, 20]);
  tick(s, p);
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol, p.reload], [12, 13, null]);
  for (let i = 0; i < 25; i++) tick(s, p);
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol], [12, 13], 'transferred once; no auto-reload');

  p.inventory[0].ammo = 5; p.reserves.pistol = 3;
  tick(s, p, { reload: true });
  for (let i = 0; i < 20; i++) tick(s, p);
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol], [8, 0], 'a short reserve loads what it has');
  tick(s, p, { reload: true });
  assert.equal(p.reload, null, 'nothing to load: no reload starts');
  p.reserves.pistol = 5; p.inventory[0].ammo = 12;
  tick(s, p, { reload: true });
  assert.equal(p.reload, null, 'a full magazine does not reload');
});

test('movement continues while reloading, and the reload completes on the move', () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(0); p.reserves.pistol = 30;
  const x = p.x;
  tick(s, p, { reload: true, x: 1 });
  for (let i = 0; i < 20; i++) tick(s, p, { x: 1 });
  assert.ok(p.x > x + 50, `moved ${p.x - x}`);
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol], [12, 18]);
});

test('switch, move, drop and stun cancel before transfer; every round is conserved', () => {
  const cases = {
    switch: (s, p) => tick(s, p, { slot: 1 }),
    move: (s, p) => tick(s, p, { moveSlot: { from: 0, to: 2 } }),
    drop: (s, p) => tick(s, p, { drop: true }),
    stun: (s, p) => { p.stun = 5; tick(s, p); },
  };
  for (const [name, interrupt] of Object.entries(cases)) {
    const { s, p } = fixture();
    p.inventory[0] = pistol(4); p.inventory[1] = { kind: 'med', count: 1, instanceId: 'med', lineageId: 'med' }; p.reserves.pistol = 30;
    const before = rounds(s, 'pistol');
    tick(s, p, { reload: true });
    for (let i = 0; i < 18; i++) tick(s, p);
    interrupt(s, p);
    assert.equal(p.reload, null, name);
    for (let i = 0; i < 30; i++) tick(s, p);
    assert.equal(p.reserves.pistol, 30, `${name}: nothing transferred`);
    assert.equal(rounds(s, 'pistol'), before, name);
  }
  const { s, p } = fixture();
  p.inventory[0] = pistol(4); p.reserves.pistol = 30;
  tick(s, p, { reload: true }); tick(s, p, { drop: true });
  const dropped = s.map.items.find(item => item.id === 'gun');
  assert.equal(dropped.ammo, 4, 'a dropped weapon keeps its magazine');
  assert.equal(p.reserves.pistol, 30, 'and not the player\'s reserve');
});

test('selecting the reloading slot again does not cancel; a switch and reload in one input reloads the new slot', () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(4); p.inventory[1] = pistol(2, 'other'); p.reserves.pistol = 30;
  tick(s, p, { reload: true });
  tick(s, p, { slot: 0 });
  assert.ok(p.reload);
  tick(s, p, { slot: 1, reload: true });
  assert.deepEqual([p.reload.slot, p.reload.instanceId], [1, 'other']);
  for (let i = 0; i < 20; i++) tick(s, p);
  assert.deepEqual([p.inventory[0].ammo, p.inventory[1].ammo, p.reserves.pistol], [4, 12, 20]);
});

test('R and M in one input: the move applies first, then the reload fills the moved, still-selected weapon', () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(4); p.reserves.pistol = 30;
  tick(s, p, { moveSlot: { from: 0, to: 2 }, reload: true });
  assert.deepEqual([p.selectedSlot, p.reload?.slot, p.reload?.instanceId], [2, 2, 'gun']);
  tick(s, p, { reload: true });
  assert.equal(p.reload.until, s.tick + 19, 'pressing again does not restart it');
  for (let i = 0; i < 19; i++) tick(s, p);
  assert.deepEqual([p.inventory[2].ammo, p.reserves.pistol], [12, 22]);
});

test('death drops every reserve family and the magazines as recoverable pickups', () => {
  const { s, p, q } = fixture();
  p.inventory[0] = pistol(7); p.inventory[1] = { kind: 'weapon', weaponType: 'rifle', ammo: 3, instanceId: 'r', lineageId: 'r' };
  Object.assign(p.reserves, { pistol: 40, rifle: 0, shell: 9 });
  tick(s, p, { reload: true });
  const before = ['pistol', 'rifle', 'shell'].map(family => rounds(s, family));
  eliminate(s, p, null);
  assert.equal(p.reload, null);
  assert.deepEqual(p.reserves, { pistol: 0, rifle: 0, shell: 0 });
  assert.deepEqual(s.map.items.filter(item => item.kind === 'ammo').map(item => [item.family, item.count]), [['pistol', 40], ['shell', 9]]);
  assert.deepEqual(['pistol', 'rifle', 'shell'].map(family => rounds(s, family)), before);
  q.x = p.x; q.y = p.y;
  for (const item of s.map.items) { item.x = q.x; item.y = q.y; }
  automaticPickups(s, q, {});
  assert.deepEqual([q.reserves.pistol, q.reserves.shell], [40, 9]);
  assert.deepEqual(['pistol', 'rifle', 'shell'].map(family => rounds(s, family)), before);
});

test('ammo pickups fill reserves with six full slots, leave the remainder, and a full reserve leaves them untouched', () => {
  const { s, p } = fixture();
  for (let slot = 0; slot < 6; slot++) p.inventory[slot] = { kind: 'med', count: 3, instanceId: `m${slot}`, lineageId: `m${slot}` };
  p.reserves.pistol = 60;
  const pile = { id: 'pile', kind: 'ammo', family: 'pistol', count: 20, x: p.x, y: p.y };
  s.map.items.push(pile);
  // A partial take replaces the ground record (22.1 "Frames"), so look it up again.
  const ground = () => s.map.items.find(item => item.id === 'pile');
  automaticPickups(s, p, {});
  assert.deepEqual([p.reserves.pistol, ground()?.count, pile.count], [72, 8, 20]);
  const left = ground();
  automaticPickups(s, p, {});
  assert.deepEqual([p.reserves.pistol, ground()?.count], [72, 8]);
  assert.equal(ground(), left, 'a full reserve leaves the pickup untouched');
  p.reserves.pistol = 0;
  automaticPickups(s, p, {});
  assert.deepEqual([p.reserves.pistol, ground()], [8, undefined]);
  assert.equal(collectAmmo(s, p, { id: 'bad', kind: 'ammo', family: 'laser', count: 3, x: 0, y: 0 }), false);
});

test('a matching weapon feeds its family reserve; its magazine never merges into the carried one', () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(3); p.reserves.pistol = 65;
  const spare = { id: 'spare', kind: 'weapon', weaponType: 'pistol', ammo: 12, x: p.x, y: p.y };
  s.map.items.push(spare);
  assert.equal(collectInstanceEquipment(s, p, spare), false);
  assert.deepEqual([p.inventory[0].ammo, p.reserves.pistol, spare.ammo], [3, 72, 5]);
  assert.equal(p.inventory.filter(Boolean).length, 1);
});

test('the ammo-drop intent drops a bounded reserve quantity as one pickup; a self-drop waits a second', () => {
  const { s, p } = fixture();
  p.reserves.rifle = 50;
  tick(s, p, { dropAmmo: { family: 'rifle', count: 20 } });
  const pile = s.map.items.find(item => item.kind === 'ammo');
  assert.deepEqual([p.reserves.rifle, pile.family, pile.count, pile.droppedBy], [30, 'rifle', 20, p.id]);
  tick(s, p, { dropAmmo: { family: 'rifle', count: 999 } });
  assert.equal(p.reserves.rifle, 0, 'at most the reserve drops');
  assert.equal(rounds(s, 'rifle'), 50);
  tick(s, p, { dropAmmo: { family: 'rifle', count: 5 } });
  assert.equal(s.map.items.filter(item => item.kind === 'ammo').length, 2, 'an empty reserve drops nothing');
  for (const item of s.map.items) { item.x = p.x; item.y = p.y; }
  tick(s, p);
  assert.equal(p.reserves.rifle, 0, 'own drop is not recollected at once');
  for (let i = 0; i < 20; i++) tick(s, p);
  assert.equal(p.reserves.rifle, 50);
});

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

test('the owner sees reserves and reload progress; other players and older content do not', () => {
  const { s, p, q } = fixture();
  q.x = p.x + 40;
  p.inventory[0] = pistol(1); p.reserves.pistol = 9;
  tick(s, p, { reload: true });
  const frame = snapshot(s), own = playerView(s, frame, p.id), other = playerView(s, frame, q.id);
  assert.deepEqual(own.players.find(r => r.id === p.id).reserves, { pistol: 9, rifle: 0, shell: 0 });
  assert.equal(own.players.find(r => r.id === p.id).reload.instanceId, 'gun');
  const seen = other.players.find(r => r.id === p.id);
  assert.equal(seen.reserves, undefined); assert.equal(seen.reload, undefined);
  // Ground ammo keeps its family on the live wire, as in recorded frames.
  s.map.items = [...s.map.items, { id: 'box', kind: 'ammo', family: 'shell', count: 4, x: q.x, y: q.y }];
  const box = playerView(s, snapshot(s), q.id).items.find(item => item.id === 'box');
  assert.equal(box.family, 'shell');
  const legacy = createGame(17, arena(), content('content-5'));
  assert.equal(Object.hasOwn(snapshot(legacy).players[0], 'reserves'), false);
});

test('a full inventory E swap stages reserves: a rejected swap leaves them unchanged', () => {
  const { s, p } = fixture();
  for (let slot = 0; slot < 6; slot++) p.inventory[slot] = pistol(2, `g${slot}`);
  p.inventory[1] = { kind: 'med', count: 1, instanceId: 'm', lineageId: 'm' };
  p.selectedSlot = 1; p.reserves.pistol = 70;
  // The pickup would feed the reserve, but its 5 rounds cannot all fit: the swap is refused whole.
  const spare = { id: 'spare', kind: 'weapon', weaponType: 'pistol', ammo: 5, x: p.x, y: p.y };
  s.map.items.push(spare);
  interact(s, p);
  assert.deepEqual([p.reserves.pistol, spare.ammo, p.inventory[1].kind], [70, 5, 'med']);
});

test('bots reload from their reserves, and a whole bot match conserves every round it does not fire', () => {
  const fixtures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/behavior-nav-1.json.gz', import.meta.url))));
  const s = createGame(17, structuredClone(Object.values(fixtures.maps)[0]), contentById('content-ammo-1'));
  const contestants = new Set(s.players.filter(p => p.role === 'contestant').map(p => p.id));
  // One attack spends one round however many pellets it fires, so count shooter-ticks.
  const shots = new Set();
  class Counted extends Array { push(...items) { for (const b of items) if (contestants.has(b.owner)) shots.add(`${b.owner}@${s.tick}`); return super.push(...items); } }
  s.projectiles = Counted.from(s.projectiles);
  const total = () => ['pistol', 'rifle', 'shell'].reduce((n, family) => n + rounds(s, family), 0);
  const start = total();
  let reloads = 0;
  for (let i = 0; i < 1500 && s.phase === 'live'; i++) {
    step(s);
    for (const p of s.players) if (p.reload && p.reload.until - s.tick === s.content.reloading.weapons[p.inventory[p.reload.slot].weaponType].reloadTicks) reloads++;
  }
  assert.ok(reloads > 0, 'some bot reloaded');
  assert.ok(shots.size > 0, 'bots fired');
  assert.equal(total(), start - shots.size);
});

test('current recordings keep reserves, reloads and ammo pickups exactly through backward seeks', async () => {
  const { s, p } = fixture();
  p.inventory[0] = pistol(2); p.reserves.pistol = 30;
  const chunks = [], frames = [];
  const header = { id: 'ammo-roundtrip', version: s.version, contentId: s.content.id, schema: SCHEMA,
    minSchema: minimumReaderForMatch(s.map, false), seed: s.seed, hz: 20, createdAt: 1, map: structuredClone(s.map) };
  assert.equal(header.schema, 15);
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => assert.fail(error.message) });
  const retain = () => { const frame = snapshot(s); frames.push(JSON.parse(JSON.stringify(frame))); assert.equal(writer.append(frame, []), true); };
  retain();
  tick(s, p, { reload: true }); retain();
  for (let i = 0; i < 20; i++) step(s);
  retain();
  tick(s, p, { dropAmmo: { family: 'pistol', count: 8 } }); retain();
  assert.deepEqual([frames[1].players[0].reload.instanceId, frames[2].players[0].inventory[0].ammo, frames[3].players[0].reserves.pistol], ['gun', 12, 12]);
  assert.deepEqual(frames[3].items.map(item => [item.kind, item.family, item.count]), [['ammo', 'pistol', 8]]);
  await writer.finish({ ticks: s.tick, escaped: 0 });
  const archive = JSON.parse(gunzipSync(Buffer.concat(chunks)));
  assert.equal(recordingFit(archive), 'ok');
  assert.deepEqual(archive.frames.map(frame => frame.state), frames);
  const timeline = createReplayTimeline(archive);
  for (const at of [3, 0, 2, 1, 3]) assert.deepEqual(timeline.at(frames[at].tick).state, frames[at]);
});
