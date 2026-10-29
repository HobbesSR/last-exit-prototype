import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, setInput, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { stepPhysics } from '../shared/simulation/phased.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups } from '../shared/simulation/loot.ts';
import { groundItem, groundList } from '../shared/simulation/ground-items.ts';

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
