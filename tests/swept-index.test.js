import assert from 'node:assert/strict';
import test from 'node:test';
import { closedGateShapes, firstContact, geometryContact, staticShapes, prepareSweptGeometry } from '../shared/simulation/swept.ts';
import { buildPhysicsGeometry } from '../shared/simulation/physics-geometry.ts';
import { circle, polygon } from '../shared/shape.ts';
import { openArea } from './helpers/arena.js';

// #668: geometryContact reads only the shapes in the cells a sweep's box covers. It must give the same answer,
// to the bit, as firstContact over the whole list, which brackets each shape's bisection by the contacts met
// before it, so candidates must keep list order.

function lcg(seed) { let x = seed >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

function fixture() {
  return { width: 1200, height: 900, playableArea: openArea(1200, 900, 300),
    obstacles: [
      // Long walls spanning several 200-unit buckets, one crossing a bucket corner.
      { id: 'long', kind: 'building', x: 150, y: 395, w: 700, h: 10 },
      { id: 'tall', kind: 'building', x: 595, y: 100, w: 10, h: 650 },
      { id: 'corner', kind: 'building', x: 190, y: 190, w: 20, h: 20 },
      { id: 'fence', kind: 'fence', x: 390, y: 600, w: 20, h: 200 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `crate-${i}`, kind: 'building',
        x: 40 + (i * 137) % 1100, y: 40 + (i * 271) % 800, w: 18 + i % 5, h: 14 + i % 7 })),
    ],
    gates: [
      { id: 'g1', kind: 'gate', x: 800, y: 400, w: 10, h: 40, open: false },
      { id: 'g2', kind: 'gate', x: 400, y: 200, w: 40, h: 10, open: true },
      { id: 'g3', kind: 'gate', x: 1000, y: 600, w: 10, h: 40, open: false },
    ],
  };
}

test('cooperative preparation preserves source order and both policies without lazy rebuilding', async () => {
  const map = fixture(), reference = structuredClone(map);
  map.obstacles.push(...Array.from({ length: 260 }, (_, i) => ({ id: `extra-${i}`, kind: 'fence', x: i * 3, y: 850, w: 2, h: 2 })));
  reference.obstacles = structuredClone(map.obstacles);
  const expected = [true, false].map(policy => staticShapes(reference, policy));
  let yields = 0;
  await prepareSweptGeometry(map, buildPhysicsGeometry(map), async () => { yields++; });
  assert.ok(yields > 2);
  // A cache miss would read obstacles to construct geometry or the see-through filter.
  Object.defineProperty(map, 'obstacles', { get() { assert.fail('lazy static geometry rebuild'); } });
  for (const [i, policy] of [true, false].entries()) {
    assert.deepEqual(staticShapes(map, policy), expected[i]);
    const a = { x: 0, y: 400 }, b = { x: 1100, y: 400 };
    assert.equal(geometryContact(map, policy, a, b, 2), geometryContact(reference, policy, a, b, 2));
  }
});

for (const rejectAt of [1, 2]) test(`rejected sweep preparation leaves the lazy path complete (yield ${rejectAt})`, async () => {
  const map = fixture();
  map.obstacles.push(...Array.from({ length: 130 }, (_, i) => ({ id: `extra-${i}`, kind: 'fence', x: i * 3, y: 850, w: 2, h: 2 })));
  const reference = structuredClone(map);
  let yields = 0;
  await assert.rejects(prepareSweptGeometry(map, buildPhysicsGeometry(map), async () => { if (++yields === rejectAt) throw new Error('cancel'); }), /cancel/);
  for (const policy of [true, false]) assert.deepEqual(staticShapes(map, policy), staticShapes(reference, policy));
});

for (const passSeeThrough of [true, false]) test(`indexed sweeps equal the whole-list scan (passSeeThrough ${passSeeThrough})`, () => {
  const map = fixture(), random = lcg(668);
  const whole = () => [...staticShapes(map, passSeeThrough), ...closedGateShapes(map.gates)];
  let hits = 0;
  for (let n = 0; n < 4000; n++) {
    if (n === 2000) { map.gates[0].open = true; map.gates[1].open = false; }
    // Some sweeps start on a bucket edge (multiples of 200) and cross several cells.
    const edge = n % 3 === 0;
    const a = { x: edge ? 200 * Math.floor(random() * 6) : random() * 1200, y: random() * 900 };
    const length = random() < 0.5 ? random() * 60 : random() * 600, angle = random() * Math.PI * 2;
    const b = { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length };
    const radius = [0, 2, 12][n % 3];
    const expected = firstContact(a, b, whole(), radius), actual = geometryContact(map, passSeeThrough, a, b, radius);
    assert.ok(Object.is(actual, expected), `sweep ${n} ${JSON.stringify({ a, b, radius })}: ${actual} != ${expected}`);
    if (expected < Infinity) hits++;
  }
  assert.ok(hits > 500, `only ${hits} sweeps met geometry`);
});

test('a sweep along a bucket boundary meets a shape that spans the cells on both sides', () => {
  const map = fixture();
  const a = { x: 100, y: 400 }, b = { x: 1100, y: 400 };
  const expected = firstContact(a, b, [...staticShapes(map, true), ...closedGateShapes(map.gates)], 2);
  assert.ok(expected < Infinity);
  assert.ok(Object.is(geometryContact(map, true, a, b, 2), expected));
});

test('extra shapes are met after statics and gates, to the bit', () => {
  const map = fixture(), random = lcg(1668);
  // Props stand in for the hook's solid props: some overlap walls, so their place in the order matters.
  const extra = Array.from({ length: 12 }, (_, i) => polygon(100 + i * 90, 380 + (i % 3) * 20, [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 0, y: 9 }]));
  extra.push(circle(600, 400, 15), circle(805, 410, 6));
  for (let n = 0; n < 2000; n++) {
    const a = { x: random() * 1200, y: 300 + random() * 200 }, angle = random() * Math.PI * 2, length = random() * 300;
    const b = { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length };
    const expected = firstContact(a, b, [...staticShapes(map, false), ...closedGateShapes(map.gates), ...extra], 0);
    assert.ok(Object.is(geometryContact(map, false, a, b, 0, extra), expected), `sweep ${n}`);
  }
});

test('a gate added to the list is indexed', () => {
  const map = fixture(), a = { x: 700, y: 200 }, b = { x: 700, y: 330 };
  assert.equal(geometryContact(map, true, a, b, 2), Infinity);
  map.gates.push({ id: 'g4', kind: 'gate', x: 700, y: 260, w: 40, h: 10, open: false });
  const expected = firstContact(a, b, [...staticShapes(map, true), ...closedGateShapes(map.gates)], 2);
  assert.ok(expected < Infinity);
  assert.ok(Object.is(geometryContact(map, true, a, b, 2), expected));
});

test('gate shapes are built once per gate list and follow open', () => {
  const map = fixture();
  const first = closedGateShapes(map.gates);
  assert.equal(first.length, 2);
  assert.strictEqual(closedGateShapes(map.gates)[0], first[0], 'shapes are borrowed from the index');
  map.gates[0].open = true;
  assert.deepEqual(closedGateShapes(map.gates), [first[1]]);
});
