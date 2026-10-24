import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createGame, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { collectInstanceEquipment, rearrangeInstanceEquipment } from '../shared/equipment.ts';
import { automaticPickups, dropInventorySlot } from '../shared/simulation/loot.ts';
import { eliminate } from '../shared/simulation/lifecycle.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { canOccupy } from '../shared/movement.ts';
import { SCHEMA, minimumReaderForMatch, recordingFit } from '../shared/recording.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';

// No generated map, bots or hazards: only the world/inventory transition is under test.
const arena = () => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (capacity = 4096) => ({ ...structuredClone(contentById('content-equipment-1')),
  roster: { contestants: ['A', 'B'], gladiators: [] }, itemInstances: { groundCapacity: capacity }, discovery: false });
function fixture(capacity) {
  const s = createGame(17, arena(), content(capacity));
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0], q: s.players[1] };
}
const ground = (id, kind, fields = {}) => ({ id, kind, x: 120, y: 200, ...fields });
const take = (s, p, item) => {
  const consumed = collectInstanceEquipment(s, p, item);
  if (consumed) s.map.items = s.map.items.filter(other => other !== item);
  return consumed;
};

test('L0 is opt-in; old content and its snapshots keep their format', () => {
  const old = createGame(17, arena(), { ...content(), id: 'content-1', itemInstances: undefined });
  assert.notEqual(old.version, 'last-exit-0.8-equipment-1');
  assert.equal(old.itemSerial, undefined);
  assert.equal(Object.hasOwn(snapshot(old), 'itemSerial'), false);
  const { s } = fixture();
  assert.equal(s.version, 'last-exit-0.8-equipment-1');
  assert.equal(s.itemSerial, 0);
  assert.equal(snapshot(s).itemSerial, 0);
});

test('ground identity survives pickup/drop; stack split keeps a common lineage and conserves units', () => {
  const { s, p } = fixture();
  const med = ground('map-med', 'med', { count: 3, quality: 2 });
  s.map.items.push(med);
  assert.equal(take(s, p, med), true);
  assert.deepEqual([p.inventory[0].instanceId, p.inventory[0].lineageId, p.inventory[0].count, p.inventory[0].quality], ['map-med', 'map-med', 3, 2]);
  const before = s.itemSerial;
  assert.equal(dropInventorySlot(s, p, 0), true);
  assert.equal(p.inventory[0], null);
  assert.equal(s.map.items.length, 3);
  assert.equal(new Set(s.map.items.map(i => i.id)).size, 3);
  assert.equal(s.map.items.filter(i => i.id === 'map-med').length, 1);
  assert.ok(s.map.items.every(i => i.kind === 'med' && i.count === 1 && i.quality === 2 && i.lineageId === 'map-med'));
  assert.equal(s.itemSerial, before + 2);
});

test('partial ground transfers preserve the remainder; same-quality merges retain target identity', () => {
  const { s, p } = fixture();
  p.inventory[0] = { kind: 'med', count: 2, quality: 3, instanceId: 'target', lineageId: 'target' };
  const source = ground('source', 'med', { count: 3, quality: 3 });
  s.map.items.push(source);
  const before = s.itemSerial;
  assert.equal(take(s, p, source), false);
  assert.equal(p.inventory[0].count, 3);
  assert.equal(p.inventory[0].instanceId, 'target');
  assert.equal(source.id, 'source');
  assert.equal(source.count, 2);
  assert.equal(s.itemSerial, before);
  assert.equal(p.inventory.filter(Boolean).reduce((n, item) => n + (item.count ?? 1), 0) + source.count, 5);

  p.inventory[1] = { kind: 'med', count: 1, quality: 3, instanceId: 'other', lineageId: 'other' };
  assert.equal(rearrangeInstanceEquipment(s, p, 1, 0), false, 'a full target cannot absorb more');
  assert.equal(rearrangeInstanceEquipment(s, p, 0, 1), true);
  assert.equal(p.inventory[1].instanceId, 'other');
  assert.equal(p.inventory[1].count, 3);
  assert.equal(p.inventory[0].count, 1);
  p.inventory[2] = { kind: 'med', count: 1, quality: 4, instanceId: 'different', lineageId: 'different' };
  assert.equal(rearrangeInstanceEquipment(s, p, 0, 2), true);
  assert.deepEqual([p.inventory[0].quality, p.inventory[2].quality], [4, 3], 'different qualities swap without blending');
});

test('taking part of an oversized ground stack gives the carried part a child identity', () => {
  const { s, p } = fixture();
  const source = ground('five', 'shield', { count: 5, quality: 2 });
  s.map.items.push(source);
  assert.equal(take(s, p, source), false);
  assert.equal(source.id, 'five');
  assert.equal(source.count, 2);
  assert.equal(p.inventory[0].count, 3);
  assert.equal(p.inventory[0].lineageId, 'five');
  assert.notEqual(p.inventory[0].instanceId, 'five');
  const child = p.inventory[0].instanceId;
  assert.equal(take(s, p, source), true);
  assert.equal(p.inventory[0].instanceId, child);
  assert.equal(p.inventory[1].instanceId, 'five');
  assert.equal(p.inventory[1].count, 2);
  assert.equal(s.map.items.length, 0);
  assert.equal(p.inventory.reduce((n, item) => n + (item?.count ?? 0), 0), 5);
});

test('ammo transfer conserves rounds and leaves the partly used weapon on the ground', () => {
  const { s, p } = fixture();
  const max = s.content.weapons.pistol.maxAmmo;
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: max - 2, instanceId: 'carried', lineageId: 'carried' };
  const source = ground('spare', 'weapon', { weaponType: 'pistol', ammo: 7 });
  s.map.items.push(source);
  const before = s.itemSerial;
  assert.equal(collectInstanceEquipment(s, p, source), false);
  assert.equal(p.inventory[0].ammo, max);
  assert.equal(p.inventory[0].instanceId, 'carried');
  assert.equal(source.ammo, 5);
  assert.equal(source.id, 'spare');
  assert.equal(s.itemSerial, before);
  assert.equal(collectInstanceEquipment(s, p, source), false);
  assert.equal(source.ammo, 5);
});

test('optional capacity failure and invalid slot/payload do not mutate inventory or counters', () => {
  const { s, p } = fixture(1);
  p.inventory[0] = { kind: 'shield', count: 2, instanceId: 'shield', lineageId: 'shield' };
  const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
  assert.equal(dropInventorySlot(s, p, 0), false);
  assert.equal(dropInventorySlot(s, p, 9), false);
  assert.equal(dropInventorySlot(s, p, 0.5), false);
  assert.equal(rearrangeInstanceEquipment(s, p, -1, 1), false);
  assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
  for (const bad of [ground('bad-count', 'med', { count: -1 }), ground('bad-ammo', 'weapon', { weaponType: 'pistol', ammo: NaN }), ground('bad-quality', 'cell', { charge: 2, quality: 9 })]) {
    s.map.items.push(bad);
    const invalidBefore = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
    assert.equal(collectInstanceEquipment(s, p, bad), false);
    assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, invalidBefore);
    s.map.items.pop();
  }
});

test('mandatory death drops exceed optional capacity, retain charge, and remain collectable', () => {
  const { s, p, q } = fixture(1);
  p.inventory[0] = { kind: 'med', count: 3, instanceId: 'med', lineageId: 'med' };
  p.inventory[1] = { kind: 'cell', charge: s.content.cellChargeTicks, instanceId: 'cell', lineageId: 'cell', quality: 4 };
  eliminate(s, p, null);
  assert.equal(s.map.items.length, 4);
  assert.equal(s.map.items.find(i => i.id === 'cell').charge, s.content.cellChargeTicks);
  assert.equal(s.map.items.find(i => i.id === 'cell').quality, 4);
  assert.ok(s.map.items.every(i => Number.isFinite(i.x) && Number.isFinite(i.y)));
  assert.ok(p.inventory.every(i => i === null));
  eliminate(s, p, null);
  assert.equal(s.map.items.length, 4);
  const fallenCell = s.map.items.find(i => i.id === 'cell');
  assert.equal(take(s, q, fallenCell), true);
  assert.equal(q.inventory.find(Boolean).instanceId, 'cell');
  assert.equal(q.inventory.find(Boolean).charge, s.content.cellChargeTicks);
  assert.equal(s.map.items.length, 3);
});

test('E swap is atomic at capacity and a successful swap cannot repick its own drop this tick', () => {
  for (const capacity of [1, 2]) {
    const { s, p } = fixture(capacity);
    p.inventory[0] = { kind: 'med', count: 2, instanceId: 'owned-0', lineageId: 'owned-0' };
    for (let i = 1; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i + 10, instanceId: `owned-${i}`, lineageId: `owned-${i}` };
    const incoming = ground('incoming', 'cell', { charge: 73 });
    s.map.items.push(incoming);
    const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
    setInput(s, p.id, { seq: 1, interact: true }); step(s);
    if (capacity === 1) {
      assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
    } else {
      assert.equal(p.inventory[0].instanceId, 'incoming');
      assert.equal(p.inventory[0].charge, 73);
      assert.equal(s.map.items.length, 2);
      assert.ok(s.map.items.some(i => i.id === 'owned-0'));
      assert.ok(s.map.items.every(i => i.kind === 'med' && i.count === 1 && i.droppedBy === p.id && i.pickupAfter > s.tick));
    }
  }
});

test('failed E preview leaves a partially refillable pistol and the outgoing stack untouched', () => {
  const { s, p } = fixture(1);
  const max = s.content.weapons.pistol.maxAmmo;
  p.inventory[0] = { kind: 'med', count: 2, instanceId: 'old-med', lineageId: 'old-med' };
  p.inventory[1] = { kind: 'weapon', weaponType: 'pistol', ammo: max - 2, instanceId: 'old-pistol', lineageId: 'old-pistol' };
  for (let i = 2; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i, instanceId: `old-${i}`, lineageId: `old-${i}` };
  s.map.items.push(ground('refill', 'weapon', { weaponType: 'pistol', ammo: 7 }));
  const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
  interact(s, p);
  assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
  assert.equal(p.inventory[1].ammo, max - 2);
  assert.equal(s.map.items[0].ammo, 7);
});

test('a successful E swap stages only the pickup: the map and other ground entries are untouched', () => {
  const { s, p } = fixture();
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i + 1, instanceId: `owned-${i}`, lineageId: `owned-${i}` };
  const bystander = ground('bystander', 'med', { x: 500, y: 300 });
  s.map.items.push(bystander, ground('incoming', 'cell', { charge: 9 }));
  const map = s.map;
  interact(s, p);
  assert.equal(p.inventory[0].instanceId, 'incoming');
  assert.equal(s.map, map);
  assert.ok(s.map.items.includes(bystander), 'unrelated ground entries keep their object identity');
  assert.deepEqual(s.map.items.map(i => i.id).sort(), ['bystander', 'owned-0']);
});

test('E cannot swap back a fresh self-drop even when all slots are filled again', () => {
  const { s, p } = fixture(2);
  for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i + 1, instanceId: `owned-${i}`, lineageId: `owned-${i}` };
  assert.equal(dropInventorySlot(s, p, 0), true);
  assert.equal(s.map.items.length, 1);
  assert.ok(Math.hypot(s.map.items[0].x - p.x, s.map.items[0].y - p.y) < 70);
  p.inventory[0] = { kind: 'med', count: 1, instanceId: 'replacement', lineageId: 'replacement' };
  const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
  interact(s, p);
  assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
});

test('a malformed carried entry cannot halt elimination; well-formed value still drops', () => {
  const { s, p } = fixture();
  p.inventory[0] = { kind: 'cell', charge: 12, instanceId: 'good', lineageId: 'good' };
  p.inventory[1] = { kind: 'weapon', weaponType: 'pistol', ammo: Number.NaN, instanceId: 'bad', lineageId: 'bad' };
  assert.doesNotThrow(() => eliminate(s, p, null));
  assert.deepEqual(s.map.items.map(i => i.id), ['good']);
  assert.ok(p.inventory.every(i => i === null));
});

test('failed optional scattering leaves all state intact; mandatory drop keeps a logical fallback', () => {
  const { s, p, q } = fixture();
  p.inventory[0] = { kind: 'cell', charge: s.content.cellChargeTicks, instanceId: 'sealed-cell', lineageId: 'sealed-cell' };
  s.map.obstacles.push(
    { id: 'upper-wall', kind: 'wall', x: 0, y: 0, w: s.map.width, h: 187 },
    { id: 'lower-wall', kind: 'wall', x: 0, y: 213, w: s.map.width, h: s.map.height - 213 });
  q.x = 140; q.y = 200;
  assert.equal(canOccupy(s.map, p.x, p.y, 12), true, 'the actor fits in the corridor');
  assert.equal(canOccupy(s.map, q.x, q.y, 12), true);
  const before = structuredClone({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial });
  assert.equal(dropInventorySlot(s, p, 0), false);
  assert.deepEqual({ inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial }, before);
  assert.equal(dropInventorySlot(s, p, 0, true), true);
  assert.equal(p.inventory[0], null);
  assert.deepEqual([s.map.items[0].x, s.map.items[0].y], [p.x, p.y]);
  assert.equal(s.map.items[0].id, 'sealed-cell');
  assert.equal(s.map.items[0].charge, s.content.cellChargeTicks);
  automaticPickups(s, q, {});
  assert.equal(s.map.items.length, 0);
  assert.equal(q.inventory.find(Boolean).instanceId, 'sealed-cell');
  assert.equal(q.inventory.find(Boolean).charge, s.content.cellChargeTicks);
});

test('forty transfers between players conserve all units, ammo and charge with unique IDs', () => {
  const { s, p, q } = fixture();
  s.map.items.push(ground('three-meds', 'med', { count: 3 }),
    ground('loaded', 'weapon', { weaponType: 'rifle', ammo: 7 }),
    ground('charged', 'cell', { charge: s.content.cellChargeTicks }));
  const inventoryItems = () => s.players.flatMap(player => player.inventory.filter(Boolean));
  const allItems = () => [...s.map.items, ...inventoryItems()];
  const audit = () => {
    const all = allItems();
    const ids = all.map(item => item.id ?? item.instanceId);
    assert.equal(new Set(ids).size, ids.length, 'each live world or carried instance has one ID');
    assert.equal(all.filter(item => item.kind === 'med').reduce((n, item) => n + (item.count ?? 1), 0), 3);
    assert.equal(all.filter(item => item.kind === 'weapon').reduce((n, item) => n + item.ammo, 0), 7);
    assert.equal(all.filter(item => item.kind === 'cell').reduce((n, item) => n + item.charge, 0), s.content.cellChargeTicks);
  };
  audit();
  for (let cycle = 0; cycle < 40; cycle++) {
    const owner = cycle % 2 ? q : p;
    const serialBefore = s.itemSerial;
    for (const item of [...s.map.items]) assert.equal(take(s, owner, item), true);
    audit();
    assert.equal(s.map.items.length, 0);
    for (let slot = 0; slot < owner.inventory.length; slot++) if (owner.inventory[slot]) assert.equal(dropInventorySlot(s, owner, slot), true);
    assert.ok(s.itemSerial >= serialBefore);
    assert.ok(owner.inventory.every(item => item === null));
    audit();
  }
});

test('snapshot is detached; only the owner sees carried identity and counter stays private', () => {
  const { s, p, q } = fixture();
  p.inventory[0] = { kind: 'cell', charge: 63, instanceId: 'cell-1', lineageId: 'root-1', quality: 5 };
  q.x = 130; q.y = 200;
  const frame = snapshot(s), own = playerView(s, frame, p.id), other = playerView(s, frame, q.id);
  assert.equal(frame.itemSerial, s.itemSerial);
  assert.equal(own.itemSerial, undefined);
  assert.equal(other.itemSerial, undefined);
  assert.deepEqual([own.players.find(v => v.id === p.id).inventory[0].instanceId,
    own.players.find(v => v.id === p.id).inventory[0].lineageId,
    own.players.find(v => v.id === p.id).inventory[0].quality], ['cell-1', 'root-1', 5]);
  assert.equal(Object.hasOwn(other.players.find(v => v.id === p.id), 'inventory'), false);
  frame.players[0].inventory[0].charge = 0;
  assert.equal(p.inventory[0].charge, 63);
});

test('legacy tick resolves a contested pickup by player id despite reversed array order', () => {
  const { s, p, q } = fixture();
  p.x = q.x = 120; p.y = q.y = 200;
  s.players.reverse();
  s.map.items.push(ground('contested', 'cell', { charge: 11 }));
  step(s);
  assert.equal(p.inventory.filter(Boolean).length, 1);
  assert.equal(q.inventory.filter(Boolean).length, 0);
  assert.equal(s.map.items.length, 0);
});

test('identical traces yield identical identities, counters, quantities and snapshots', () => {
  function trace() {
    const { s, p } = fixture();
    s.map.items.push(ground('med', 'med', { count: 2 }), ground('cell', 'cell', { charge: 41, x: 300 }));
    step(s);
    setInput(s, p.id, { seq: 1, slot: 0, drop: true }); step(s);
    return { inventory: p.inventory, items: s.map.items, itemSerial: s.itemSerial,
      rng: s.rng, serial: s.serial, frame: snapshot(s) };
  }
  assert.deepEqual(trace(), trace());
});

test('schema 11 recording roundtrip and backward seeks retain exact item-instance frames', async () => {
  const map = arena();
  map.items.push(ground('med-root', 'med', { count: 3, quality: 3 }),
    ground('rifle-root', 'weapon', { weaponType: 'rifle', ammo: 7, quality: 2 }),
    ground('cell-root', 'cell', { charge: 100, quality: 4 }));
  const s = createGame(17, map, content());
  for (const player of s.players) { player.bot = false; player.input = {}; }
  const p = s.players[0], chunks = [];
  const header = { id: 'item-roundtrip', version: s.version, contentId: s.content.id,
    schema: SCHEMA, minSchema: minimumReaderForMatch(map, false), seed: s.seed,
    hz: 20, createdAt: 1, map: structuredClone(map) };
  assert.equal(header.schema, 11);
  assert.equal(header.minSchema, 4);
  assert.equal(recordingFit(header), 'ok');
  assert.equal(recordingFit({ ...header, schema: 10, minSchema: 10 }), 'ok');
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => assert.fail(error.message) });
  const frames = [];
  const retain = () => {
    const frame = snapshot(s);
    frames.push(JSON.parse(JSON.stringify(frame))); // Expected wire value; JSON omits undefined input fields.
    assert.equal(writer.append(frame, []), true);
  };
  retain();
  step(s); retain();
  assert.deepEqual(p.inventory.filter(Boolean).map(i => [i.instanceId, i.lineageId, i.quality]),
    [['med-root', 'med-root', 3], ['rifle-root', 'rifle-root', 2], ['cell-root', 'cell-root', 4]]);
  for (let slot = 0; slot < 3; slot++) { setInput(s, p.id, { seq: slot + 1, slot, drop: true }); step(s); retain(); }
  const finalItems = frames.at(-1).items;
  assert.equal(finalItems.length, 5);
  assert.equal(finalItems.filter(i => i.kind === 'med').length, 3);
  assert.equal(finalItems.find(i => i.id === 'rifle-root').ammo, 7);
  assert.equal(finalItems.find(i => i.id === 'cell-root').charge, 100);
  assert.ok(finalItems.every(i => i.lineageId && i.quality));
  assert.ok(frames.every(frame => Number.isSafeInteger(frame.itemSerial)));

  await writer.finish({ ticks: s.tick, escaped: 0 });
  const archive = JSON.parse(gunzipSync(Buffer.concat(chunks)));
  assert.equal(recordingFit(archive), 'ok');
  assert.deepEqual(archive.frames.map(frame => frame.state), frames);
  const timeline = createReplayTimeline(archive);
  for (const tick of [4, 1, 3, 0, 2, 4]) {
    assert.equal(timeline.at(tick).frameTick, tick);
    assert.deepEqual(timeline.at(tick).state, frames[tick]);
  }
});
