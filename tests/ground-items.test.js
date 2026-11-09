import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, playerView, setInput, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { stepPhysics } from '../shared/simulation/phased.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups, scatterPoint } from '../shared/simulation/loot.ts';
import { addItems, admitItem, framedItems, groundItem, groundList, groundPosition, itemsNear, poseItems, publishItems, removeItem, replaceItem, unadmittedItems } from '../shared/simulation/ground-items.ts';

// #655 stage 1 (22.1 "Frames"): frames share the ground list and its records, and a change replaces only what it touches.
const arena = items => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = id => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
const pile = (id, x, count = 20) => ({ id, kind: 'ammo', family: 'pistol', count, x, y: 300 });

test('body ownership lookup stays independent of ground size after helper removal (#863)', () => {
  let reads = 0;
  const items = Array.from({ length: 1000 }, (_, i) => pile(`i${i}`, 300));
  const removed = items[0], retained = items.at(-1);
  const s = { map: { items: new Proxy(items, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } }) } };
  assert.equal(groundItem(s, retained.id), retained);
  assert.equal(groundPosition(s, removed.id), 0);
  removeItem(s, removed);
  reads = 0;
  assert.equal(groundItem(s, removed.id), undefined);
  assert.equal(groundItem(s, retained.id), retained);
  assert.equal(reads, 0, 'ownership checks neither rebuild positions nor walk unrelated ground records');
  const moved = { ...retained, x: 450 };
  replaceItem(s, retained, moved);
  assert.equal(groundItem(s, retained.id), moved);
  const frame = publishItems(s);
  addItems(s, pile('appended', 200));
  assert.equal(groundItem(s, 'appended'), s.map.items.at(-1));
  assert.equal(frame.length, 999);
  assert.equal(groundItem({ map: { items: frame } }, retained.id), moved);
  s.map.items.push(pile('raw-push', 250));
  assert.equal(groundItem(s, 'raw-push'), s.map.items.at(-1), 'raw appends rebuild the record lookup');
  groundPosition(s, 'i1');
  s.map.items[0] = pile('raw-replacement', 100);
  assert.equal(groundItem(s, 'i1'), undefined, 'an existing positional index still detects a replaced id');
  assert.equal(groundItem(s, 'raw-replacement'), s.map.items[0]);
  s.map.items[0] = { ...s.map.items[0], x: 175 };
  assert.equal(groundItem(s, 'raw-replacement'), s.map.items[0], 'same-id raw replacement reads the indexed record');
  groundList(s).splice(0, 1, pile('scenario', 150));
  assert.equal(groundItem(s, 'scenario'), s.map.items[0], 'arbitrary edits through groundList invalidate lookup');
});

test('pending physical items keep id order across publication, admission, edits and scenario setup (#863)', () => {
  const s = { map: { items: ['z', 'b', 'a', 'm'].map(id => pile(id, 300)) } };
  const admitted = new Set(['item:b']);
  const pending = () => [...unadmittedItems(s, admitted)];
  assert.deepEqual(pending().map(i => i.id), ['a', 'm', 'z']);
  const frame = publishItems(s);
  addItems(s, pile('c', 200));
  const moved = { ...s.map.items[0], x: 100 };
  replaceItem(s, s.map.items[0], moved);
  removeItem(s, s.map.items.find(i => i.id === 'm'));
  assert.equal(groundItem(s, 'c'), s.map.items.at(-1));
  assert.deepEqual(pending().map(i => i.id), ['a', 'c', 'z']);
  assert.equal(pending().at(-1), moved);
  const visited = [];
  for (const item of unadmittedItems(s, admitted)) {
    visited.push(item.id); admitted.add(`item:${item.id}`); admitItem(s, item);
  }
  assert.deepEqual(visited, ['a', 'c', 'z'], 'admitting the current item never skips its successor');
  assert.deepEqual(pending(), []);
  assert.deepEqual(frame.map(i => i.id), ['z', 'b', 'a', 'm']);
  s.map.items.push(pile('raw', 250));
  assert.deepEqual(pending().map(i => i.id), ['raw'], 'a direct scenario push rebuilds the pending list');
  groundList(s).splice(0, 1, pile('scenario', 250));
  assert.deepEqual(pending().map(i => i.id), ['raw', 'scenario'], 'groundList allows arbitrary same-length scenario edits');
});

test('scatter over the live grid equals the whole-list stand-in scan, including staged points (#863)', () => {
  const items = Array.from({ length: 700 }, (_, i) => ({ ...pile(`s${i}`, (i * 131) % 600), y: (i * 79) % 400 }));
  const s = createGame(17, arena(items), content('content-ammo-1'));
  publishItems(s);
  const compare = (origin, phase, points = []) => assert.deepEqual(scatterPoint(s, origin, phase, s.map.items, points),
    scatterPoint(s, origin, phase, s.map.items.slice(), points));
  for (let phase = 0; phase < 24; phase++) compare({ x: 120 + phase * 15, y: 200 }, phase, [{ x: 156, y: 200 }]);
  // The stand-in deliberately excludes pickups during a swap; it must not query their live grid entries.
  const clear = createGame(17, arena([pile('blocker', 336)]), content('content-ammo-1'));
  replaceItem(clear, clear.map.items[0], { ...clear.map.items[0], y: 200 });
  publishItems(clear);
  const origin = { x: 300, y: 200 }, first = { x: 336, y: 200 };
  assert.deepEqual(scatterPoint(clear, origin, 0, []), first);
  assert.notDeepEqual(scatterPoint(clear, origin, 0, clear.map.items), first);
  addItems(clear, { ...pile('nan', NaN), y: NaN });
  assert.equal(scatterPoint(clear, origin, 0, clear.map.items), undefined, 'non-finite records still block every candidate');
});

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

test('an unchanged record projects to one shared object in every view and frame; a replaced one projects anew', () => {
  const s = createGame(17, arena([pile('a', 300), pile('b', 500)]), content('content-ammo-1'));
  for (const p of s.players) p.bot = false;
  const viewers = [null, ...s.players.map(p => p.id)];
  const first = snapshot(s), directed = playerView(s, first, null).items;
  assert.deepEqual(directed.map(item => item.id), ['a', 'b']);
  assert.ok(directed.every(Object.isFrozen));
  // Player views carry the directed view's objects, so frame-layers same() matches them by identity.
  for (const viewer of viewers) for (const item of playerView(s, first, viewer).items) assert.equal(item, directed.find(d => d.id === item.id));
  replaceItem(s, s.map.items[0], { ...s.map.items[0], count: 5 });
  const [a, b] = playerView(s, snapshot(s), null).items;
  assert.notEqual(a, directed[0]); assert.equal(a.count, 5);
  assert.equal(b, directed[1]);
  // An older frame still projects as it showed.
  assert.equal(playerView(s, first, null).items[0], directed[0]);
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
