import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, setInput, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { stepPhysics } from '../shared/simulation/phased.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups } from '../shared/simulation/loot.ts';
import { addItems, framedItems, groundItem, groundList, itemsNear, poseItems, publishItems, removeItem, replaceItem } from '../shared/simulation/ground-items.ts';

// #655 stage 1 (22.1 "Frames"): frames share the ground list and its records, and a change replaces only what it touches.
const arena = items => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = id => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
const pile = (id, x, count = 20) => ({ id, kind: 'ammo', family: 'pistol', count, x, y: 300 });

test('an unchanged ground is shared between frames, frozen, and never cloned', () => {
  const s = createGame(17, arena([pile('a', 300), pile('b', 500)]), content('content-ammo-1'));
  for (const p of s.players) p.bot = false;
  const first = snapshot(s), second = snapshot(s);
  assert.equal(second.items, first.items);
  assert.equal(first.items, s.map.items);
  assert.ok(first.items.every(Object.isFrozen));
  assert.throws(() => { first.items[0].count = 1; }, TypeError);
  // The list itself is marked, not frozen (V8 filters and serializes frozen arrays slowly): a rule's change copies it.
  groundList(s).push(pile('c', 100));
  assert.deepEqual(first.items.map(item => item.id), ['a', 'b']);
});

test('a partial pickup replaces only its own record; published frames keep what they showed', () => {
  const s = createGame(17, arena([pile('near', 120), pile('far', 500)]), content('content-ammo-1'));
  const p = s.players[0];
  for (const q of s.players) q.bot = false;
  p.x = 120; p.y = 300; p.reserves.pistol = 72;
  const before = snapshot(s), [near, far] = before.items;
  automaticPickups(s, p, {});
  assert.equal(s.map.items, before.items, 'a full reserve changes nothing, so nothing is copied');
  p.reserves.pistol = 60;
  automaticPickups(s, p, {});
  const after = snapshot(s);
  assert.notEqual(after.items, before.items);
  assert.equal(after.items[1], far, 'an untouched record is the same object');
  assert.deepEqual([after.items[0].count, near.count, p.reserves.pistol], [8, 20, 72]);
  assert.equal(groundItem(s, 'near'), after.items[0]);
});

test('adding to a published ground copies the list once and leaves the frame alone', () => {
  const s = createGame(17, arena([pile('a', 300)]), content('content-ammo-1'));
  const frame = snapshot(s);
  groundList(s).push(pile('b', 400));
  groundList(s).push(pile('c', 450));
  assert.deepEqual(frame.items.map(item => item.id), ['a']);
  assert.deepEqual(s.map.items.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(s.map.items[0], frame.items[0]);
  assert.equal(groundItem(s, 'c')?.id, 'c');
  assert.throws(() => replaceItem(s, s.map.items[0], { ...s.map.items[0], id: 'other' }), /replacing ground item a/);
});

test('the item grid offers every record in reach, in list order, through adds, removals, moves and frames (#641)', () => {
  let seed = 641;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const at = () => random() < 0.03 ? NaN : random() * 2000 - 200;
  const s = { map: { items: Array.from({ length: 300 }, (_, i) => ({ id: `i${i}`, kind: 'med', x: at(), y: at() })) } };
  const frames = [];
  let serial = 300;
  for (let step = 0; step < 2000; step++) {
    const items = s.map.items, roll = random(), item = items[Math.floor(random() * items.length)];
    if (roll < 0.2) addItems(s, { id: `i${serial++}`, kind: 'med', x: at(), y: at() });
    else if (roll < 0.35 && item) removeItem(s, item);
    else if (roll < 0.6 && item) replaceItem(s, item, { ...item, x: item.x + random() * 80 - 40, y: item.y + random() * 80 - 40 });
    else if (roll < 0.65 && item && !Object.isFrozen(item)) item.x = at(); // Before its first frame, a record may still be moved in place.
    else if (roll < 0.75) frames.push({ list: publishItems(s), ids: s.map.items.map(i => i.id) });
    const p = { x: random() * 1600, y: random() * 1600 }, reach = [38, 45, 130][step % 3];
    const expected = s.map.items.filter(i => !(Math.hypot(i.x - p.x, i.y - p.y) > reach));
    assert.deepEqual(itemsNear(s, p, reach).filter(i => expected.includes(i)), expected, `step ${step}`);
  }
  assert.ok(frames.length > 100);
  for (const frame of frames) assert.deepEqual(frame.list.map(i => i.id), frame.ids, 'a published list never changes');
  const p = { x: 500, y: 500 };
  assert.ok(itemsNear(s, p, 45).length < s.map.items.length / 4, 'a query reads a neighbourhood, not the map');
  assert.deepEqual(itemsNear(s, { x: NaN, y: 0 }, 45), s.map.items, 'a position that compares as nothing is offered everything');
});

test('a viewer\'s items through the grid are exactly the whole-list filter, for live, posed and older frames (#641)', () => {
  let seed = 4217;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const at = () => random() < 0.02 ? NaN : random() * 9000 - 500;
  const s = { map: { items: Array.from({ length: 1500 }, (_, i) => ({ id: `i${i}`, kind: 'med', x: at(), y: at() })) } };
  const frames = [];
  let serial = 1500, wide = 0;
  for (let step = 0; step < 600; step++) {
    const items = s.map.items, item = items[Math.floor(random() * items.length)], roll = random();
    if (roll < 0.2) addItems(s, { id: `i${serial++}`, kind: 'med', x: at(), y: at() });
    else if (roll < 0.3 && item) removeItem(s, item);
    else if (roll < 0.5 && item) replaceItem(s, item, { ...item, x: item.x + random() * 400 - 200, y: item.y + random() * 400 - 200 });
    else if (roll < 0.55) s.map.items.push({ id: `pushed${serial++}`, kind: 'med', x: at(), y: at() }); // A test arranging a scenario.
    const ground = publishItems(s);
    // A frame's posed copy: some records moved by their bodies, by any distance, across any cell or the view edge.
    const swaps = new Map();
    for (let k = random() * 6; k > 0; k--) {
      const i = Math.floor(random() * ground.length);
      swaps.set(i, Object.freeze({ ...ground[i], x: random() < 0.5 ? ground[i].x + random() * 60 - 30 : at(), y: at() }));
    }
    const frame = swaps.size ? poseItems(ground, swaps) : ground;
    frames.push(frame);
    const viewer = { x: random() * 8000, y: random() * 8000 }, reach = [1692, 600, 45][step % 3];
    for (const list of [frame, frames[Math.floor(random() * frames.length)]]) {
      const inRange = i => Math.hypot(viewer.x - i.x, viewer.y - i.y) < reach;
      const expected = list.filter(inRange), got = framedItems(s, list, viewer, reach, inRange);
      assert.deepEqual(got, expected, `step ${step}`);
      if (reach > 1000 && got.length) wide++;
    }
  }
  assert.ok(wide > 50, 'the view reach is exercised with something in range');
  assert.deepEqual(framedItems(s, s.map.items, { x: NaN, y: 0 }, 1692, () => true), s.map.items, 'a viewer that compares as nothing is tested against everything');
});

test('physics writes back only the item bodies that moved', async () => {
  const s = await createPhysicsGame(17, arena([{ id: 'w', kind: 'weapon', weaponType: 'pistol', x: 300, y: 300 }]), content('content-6'));
  try {
    for (const p of s.players) { p.bot = false; }
    let seq = 0;
    const tick = () => { for (const p of s.players) setInput(s, p.id, { seq: ++seq }); stepPhysics(s); return snapshot(s); };
    const settled = tick();
    assert.ok(physicsRuntime(s).items.has('item:w'), 'the item has a body');
    assert.equal(tick().items, settled.items, 'a resting item body leaves the shared list untouched');
  } finally { disposePhysics(s); }
});
