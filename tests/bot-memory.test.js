import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemMemory, NEIGHBOURS, SeenCells, rememberedItems, seenCells } from '../shared/simulation/bot-memory.ts';

// The indexes a bot reads its memory through (#864) answer as a scan of the whole collection would, in the same order:
// a tie in a bot's choice goes to the first it meets, so a different order is a different match.

/** A small deterministic generator, so a failure replays. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** What `exploreTarget` met before the frontier was kept: every seen cell's unseen neighbours, in scan order, once each. */
function scannedFrontier(seen, cols, rows) {
  const found = [];
  for (const index of seen) {
    const col = index % cols, row = (index - col) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc, r = row + dr, next = r * cols + c;
      if (c < 0 || r < 0 || c >= cols || r >= rows || seen.has(next) || found.includes(next)) continue;
      found.push(next);
    }
  }
  return found;
}

test('the frontier is the unseen neighbours of seen cells, in the order a scan meets them', () => {
  const cols = 9, rows = 6, random = rng(7);
  const seen = new SeenCells(cols, rows);
  for (let step = 0; step < 120; step++) {
    seen.add(Math.floor(random() * cols * rows));
    assert.deepEqual([...seen.frontier], scannedFrontier(seen, cols, rows), `after ${seen.size} cells`);
  }
});

test('a seen cell is added once and keeps its place', () => {
  const seen = new SeenCells(5, 5);
  seen.add(12).add(12).add(13);
  assert.deepEqual([...seen], [12, 13]);
  assert.deepEqual([...seen.frontier], scannedFrontier(seen, 5, 5));
});

test('removing or clearing seen cells derives the frontier again', () => {
  const cols = 8, rows = 5, random = rng(11);
  const seen = new SeenCells(cols, rows);
  for (let i = 0; i < 25; i++) seen.add(Math.floor(random() * cols * rows));
  seen.delete([...seen][3]);
  assert.deepEqual([...seen.frontier], scannedFrontier(seen, cols, rows));
  seen.add(0); seen.add(39);
  assert.deepEqual([...seen.frontier], scannedFrontier(seen, cols, rows), 'and keeps up afterwards');
  seen.clear();
  assert.deepEqual([...seen.frontier], []);
  seen.add(20);
  assert.deepEqual([...seen.frontier], scannedFrontier(seen, cols, rows));
});

test('a scenario that sets a plain Set of seen cells is indexed in its order, once', () => {
  const memory = { discovered: new Set(), seen: new Set([30, 4, 17, 5]) };
  const indexed = seenCells(memory, 8, 5);
  assert.equal(memory.seen, indexed);
  assert.deepEqual([...indexed], [30, 4, 17, 5]);
  assert.deepEqual([...indexed.frontier], scannedFrontier(indexed, 8, 5));
  assert.equal(seenCells(memory, 8, 5), indexed, 'not again');
  const before = { discovered: new Set([2, 3]) };
  assert.deepEqual([...seenCells(before, 8, 5).frontier], scannedFrontier(before.discovered, 8, 5), 'before a bot has seen anything, the view window stands in');
  assert.equal(before.seen, undefined);
});

const item = (id, kind, x, y) => ({ id, kind, x, y });

test('remembered items answer for cells and for near loot as a scan in insertion order would', () => {
  const random = rng(3), memory = new ItemMemory(), plain = new Map();
  const edit = (id, record) => { memory.set(id, record); plain.set(id, record); };
  for (let step = 0; step < 600; step++) {
    const roll = random(), id = `i${Math.floor(random() * 40)}`;
    if (roll < 0.55) edit(id, item(id, random() < 0.25 ? 'cell' : random() < 0.5 ? 'med' : 'ammo', Math.floor(random() * 1500), Math.floor(random() * 900)));
    else if (roll < 0.9) { memory.delete(id); plain.delete(id); }
    else if (roll < 0.92) { memory.clear(); plain.clear(); }
    assert.deepEqual([...memory.keys()], [...plain.keys()]);
    assert.deepEqual(memory.cellItems(), [...plain.values()].filter(i => i.kind === 'cell'), `cells at step ${step}`);
    const at = { x: Math.floor(random() * 1500), y: Math.floor(random() * 900) }, reach = 210;
    const near = memory.near(at, reach), wanted = [...plain.values()].filter(i => i.kind !== 'cell' && Math.hypot(i.x - at.x, i.y - at.y) < reach);
    assert.deepEqual(near.filter(i => Math.hypot(i.x - at.x, i.y - at.y) < reach), wanted, `loot near ${at.x},${at.y} at step ${step}`);
    assert.ok(near.every(i => i.kind !== 'cell'), 'a superset of loot, never a cell');
    assert.deepEqual(near, [...plain.values()].filter(i => near.includes(i)), 'in insertion order');
  }
});

test('replacing a remembered item keeps its place; one that moves or changes kind is found where it is now', () => {
  const memory = new ItemMemory();
  memory.set('a', item('a', 'ammo', 100, 100)).set('b', item('b', 'med', 120, 100)).set('c', item('c', 'cell', 500, 500));
  memory.set('a', item('a', 'ammo', 900, 900));
  assert.deepEqual(memory.near({ x: 110, y: 100 }, 50).map(i => i.id), ['b']);
  assert.deepEqual(memory.near({ x: 900, y: 900 }, 50).map(i => i.id), ['a']);
  memory.set('b', item('b', 'cell', 120, 100));
  assert.deepEqual(memory.cellItems().map(i => i.id), ['b', 'c'], 'an id that changes kind keeps the place it was remembered in');
  assert.deepEqual([...memory.keys()], ['a', 'b', 'c']);
  memory.set('b', item('b', 'cell', 10, 10));
  assert.deepEqual(memory.cellItems().map(i => i.id), ['b', 'c'], 'a replaced cell keeps its place among the cells');
});

test('an item at no usable position is offered to every query', () => {
  const memory = new ItemMemory();
  memory.set('odd', item('odd', 'med', NaN, 5)).set('far', item('far', 'med', 5000, 5000));
  assert.deepEqual(memory.near({ x: 0, y: 0 }, 210).map(i => i.id), ['odd']);
  memory.delete('odd');
  assert.deepEqual(memory.near({ x: 0, y: 0 }, 210), []);
  memory.set('near', item('near', 'med', 10, 10));
  assert.deepEqual(memory.near({ x: NaN, y: 0 }, 210).map(i => i.id), ['far', 'near'], 'with no usable point, everything is offered');
  memory.set('odd', item('odd', 'med', NaN, 5));
  assert.deepEqual(memory.near({ x: NaN, y: 0 }, 210).map(i => i.id), ['far', 'near', 'odd'], 'each once, an unplaced item included');
});

test('a scenario that sets a plain Map of items is indexed in its order, once', () => {
  const memory = { discovered: new Set(), items: new Map([['x', item('x', 'cell', 1, 1)], ['y', item('y', 'med', 2, 2)]]) };
  const indexed = rememberedItems(memory);
  assert.equal(memory.items, indexed);
  assert.deepEqual(indexed.cellItems().map(i => i.id), ['x']);
  assert.equal(rememberedItems(memory), indexed);
  assert.equal(rememberedItems({ discovered: new Set() }), undefined, 'a bot that remembers nothing gains nothing');
});
