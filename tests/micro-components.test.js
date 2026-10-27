import test from 'node:test';
import assert from 'node:assert/strict';
import { unusedComponents } from '../map/micro/components.ts';
import { connectedComponents } from '../map/micro/decomposition/analysis.ts';
import { rng } from '../map/micro/random.ts';
import { cellsOf as rectangle } from './helpers/cells.js';

const keyed = cells => new Set(cells.map(c => `${c.x},${c.y}`));

/** The walk hut and compound each inlined before #383, kept verbatim as the equivalence oracle. */
function inlineWalk(owned, kept) {
  const key = (x, y) => `${x},${y}`;
  const unused = new Map(owned.filter(c => !kept.has(key(c.x, c.y))).map(c => [key(c.x, c.y), c]));
  const components = [];
  for (const start of owned) {
    if (!unused.delete(key(start.x, start.y))) continue;
    const cells = [start];
    for (let head = 0; head < cells.length; head++) {
      const { x, y } = cells[head];
      for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]]) {
        const next = unused.get(key(nx, ny));
        if (next) { unused.delete(key(nx, ny)); cells.push(next); }
      }
    }
    components.push(cells);
  }
  return components;
}

test('unused components start at the caller order and grow east, south, west, north', () => {
  // A plus with its centre first: the four arms follow in E, S, W, N order.
  const plus = [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }];
  assert.deepEqual(unusedComponents(plus, new Set()), [[plus[0], plus[3], plus[4], plus[2], plus[1]]]);
  // Reversed input starts at the other end and is not canonicalized.
  const reversed = [...plus].reverse();
  assert.deepEqual(unusedComponents(reversed, new Set())[0][0], { x: 1, y: 2 });
  assert.deepEqual(unusedComponents(reversed, new Set()), inlineWalk(reversed, new Set()));
  // The returned cells are the caller's objects.
  assert.equal(unusedComponents(plus, new Set())[0][1], plus[3]);
});

test('kept cells split a mask into disconnected components in first-cell order', () => {
  const cells = rectangle(7, 3), kept = keyed(cells.filter(c => c.x === 3));
  const parts = unusedComponents(cells, kept);
  assert.deepEqual(parts.map(p => [p[0], p.length]), [[{ x: 0, y: 0 }, 9], [{ x: 4, y: 0 }, 9]]);
  assert.ok(parts.flat().every(c => !kept.has(`${c.x},${c.y}`)));
  assert.deepEqual(unusedComponents(cells, keyed(cells)), []);
  assert.deepEqual(unusedComponents([], new Set()), []);
});

test('unused components match the former inline walk on seeded masks and orders', () => {
  for (let seed = 0; seed < 40; seed++) {
    const random = rng(seed, 'unused-components');
    const w = 4 + Math.floor(random.next() * 20), h = 4 + Math.floor(random.next() * 20);
    const owned = rectangle(w, h, () => random.next() < 0.8);
    const kept = keyed(owned.filter(() => random.next() < 0.3));
    for (const order of [owned, [...owned].reverse(), random.shuffle(owned)])
      assert.deepEqual(unusedComponents(order, kept), inlineWalk(order, kept), `seed ${seed}`);
  }
});

test('unused components cover delegation-sized yards and long strips', () => {
  // 256 × 256 is the delegation region limit (65,536 cells).
  const cells = rectangle(256, 256), kept = keyed(cells.filter(c => c.x === 128));
  assert.equal(connectedComponents(cells)[0].length, cells.length);
  const parts = unusedComponents(cells, kept);
  assert.deepEqual(parts.map(p => [p[0], p.length]), [[{ x: 0, y: 0 }, 128 * 256], [{ x: 129, y: 0 }, 127 * 256]]);
  const strip = rectangle(100, 1);
  assert.equal(connectedComponents(strip)[0].length, strip.length);
  assert.equal(unusedComponents(strip, new Set())[0].length, 100);
});
