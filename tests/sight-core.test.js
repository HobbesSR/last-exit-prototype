import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from '../shared/core.ts';
import { coreSight } from '../shared/sight-core.ts';
import { visibilityPolygon, VISION } from '../shared/sight.ts';
import { buildCore } from '../tools/build-core.mjs';
import { readArena } from '../tools/room-arena.mjs';
import { openArea } from './helpers/arena.js';

// The Rust core's visibilityPolygon must equal shared/sight.ts's bit for bit (#1175 stage 2, docs/27):
// every field of every point, signed zeros included, on synthetic maps that reach the seam and
// on-edge cases, and on the room arena's real map.
const core = coreSight(await loadCore(readFileSync(buildCore())));

function assertSame(map, origin, radius, label) {
  const expected = visibilityPolygon(map, origin, radius), actual = core.visibilityPolygon(map, origin, radius);
  assert.equal(actual.length, expected.length, `${label}: point count`);
  for (let i = 0; i < expected.length; i++) for (const key of ['x', 'y', 'angle', 'length'])
    if (!Object.is(actual[i][key], expected[i][key]))
      assert.fail(`${label}: point ${i} ${key} is ${actual[i][key]}, the TypeScript's ${expected[i][key]}`);
}

/** A fixed linear congruential sequence in [0, 1). */
function sequence(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// Every shape kind and see-through kind, across bucket borders, with gates open and closed.
function syntheticMap() {
  return {
    width: 2400, height: 2400,
    playableArea: openArea(2400, 2400, 200),
    obstacles: Array.from({ length: 120 }, (_, i) => {
      const x = 300 + i % 12 * 150, y = 300 + Math.floor(i / 12) * 160;
      const base = { id: `o${i}`, x, y, w: 35 + i % 4 * 20, h: 25 + i % 3 * 30, kind: ['building', 'window', 'pipe', 'hedge', 'tree', 'crate'][i % 6] };
      if (i % 3 === 0) return { ...base, r: 16 + i % 5 * 6 };
      if (i % 3 === 1) return { ...base, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 15, y: 35 }] };
      return base;
    }),
    gates: Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, x: 380 + i * 140, y: 230 + i % 4 * 400, open: i % 3 === 0, ...(i % 2 ? { w: 54, h: 20 } : {}) })),
  };
}

test('the core polygon equals the TypeScript on synthetic maps, at corners, on edges and across the seam', () => {
  const map = syntheticMap(), next = sequence(7);
  const origins = [];
  for (let i = 0; i < 150; i++) origins.push({ x: 100 + next() * 2200, y: 100 + next() * 2200 });
  // Exactly at an obstacle's corners and along its edges: the never-culled case.
  for (const o of map.obstacles.slice(0, 30)) if (o.points === undefined && o.r === undefined)
    origins.push({ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w / 2, y: o.y });
  // Due east of a corner, so an endpoint's angle is +-pi exactly, and due west of one.
  for (const o of map.obstacles.slice(0, 30)) origins.push({ x: o.x + 90, y: o.y }, { x: o.x - 90, y: o.y });
  for (const [i, origin] of origins.entries()) for (const radius of [VISION, 180, 47.5]) assertSame(map, origin, radius, `origin ${i} radius ${radius}`);
});

test('the open-gate mask follows the map each call, and a grown gate list is uploaded again', () => {
  const map = syntheticMap(), origin = { x: 390, y: 300 };
  for (const g of map.gates) g.open = false;
  assertSame(map, origin, VISION, 'all closed');
  for (const g of map.gates) g.open = true;
  assertSame(map, origin, VISION, 'all open');
  map.gates.push({ id: 'g-late', x: origin.x + 60, y: origin.y, open: false });
  assertSame(map, origin, VISION, 'a gate added in front of the eye');
  // A contestant's remembered map shares the obstacles but copies the gates.
  assertSame({ ...map, gates: map.gates.map(g => ({ ...g, open: !g.open })) }, origin, VISION, 'a copied gate list');
});

test('an empty map and an empty gate list cross as empty buffers', () => {
  const map = { width: 800, height: 800, playableArea: openArea(800, 800, 200), obstacles: [], gates: [] };
  assertSame(map, { x: 400, y: 400 }, VISION, 'nothing to see past');
  map.obstacles.push({ id: 'late', x: 450, y: 380, w: 40, h: 40, kind: 'building' });
  assertSame(map, { x: 400, y: 400 }, VISION, 'an obstacle added to an emptied list');
});

test('the core polygon equals the TypeScript on the room arena', () => {
  const { map } = readArena(), next = sequence(11);
  const origins = [];
  for (let i = 0; i < 200; i++) origins.push({ x: next() * map.width, y: next() * map.height });
  for (let i = 0; i < 100; i++) {
    const o = map.obstacles[Math.floor(next() * map.obstacles.length)];
    origins.push({ x: o.x, y: o.y }, { x: o.x + (o.w ?? 0), y: o.y + (o.h ?? 0) });
  }
  for (const [i, origin] of origins.entries()) assertSame(map, origin, VISION, `arena origin ${i}`);
});
