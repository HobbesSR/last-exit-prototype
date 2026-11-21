import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryContact, staticShapes, sweptUpload } from '../shared/simulation/swept.ts';
import { bounds } from '../shared/shape.ts';
import { bodyShape } from '../shared/physics/presentation-geometry.ts';
import { initCoreSight } from '../shared/sight-core.ts';
import { generatedMap } from './helpers/room-harness.js';

// The core's swept query is a port of `geometryContact` (shared/simulation/swept.ts), which keeps its
// TypeScript callers until the state flip (#1229 stage 5d.1, docs/27 "Step 5b.2"). Held equal to the bit,
// both policies, on the room arena's thousands of obstacles and its gates, opened and closed between calls.

const sight = await initCoreSight();
const RADII = [0, 2, 15, 26];
const EPS = [-0.01, -1e-6, -1e-9, 0, 1e-9, 1e-6, 0.01];

function random(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Run each sweep under both policies on both engines, asserting identical bits; count the found and the clear. */
function check(label, map, sweeps) {
  const misses = [];
  let found = 0, clear = 0;
  for (const [a, b, radius, extra = []] of sweeps) {
    for (const pass of [false, true]) {
      const want = geometryContact(map, pass, a, b, radius, extra), got = sight.sweptContact(map, pass, a, b, radius, extra);
      if (want === Infinity) clear++; else found++;
      if (!Object.is(want, got) && misses.push({ a, b, radius, pass, want, got }) >= 5) break;
    }
    if (misses.length >= 5) break;
  }
  assert.deepEqual(misses, [], `${label}: core and TypeScript differ`);
  return { found, clear };
}

const point = (x, y) => ({ x, y });

/** Sweeps that graze, start inside, cross and run through one shape's box. */
function aroundShape(shape, radius, index) {
  const box = bounds(shape), cx = box.x + box.w / 2, cy = box.y + box.h / 2, out = [];
  for (const e of EPS) {
    out.push([point(box.x - 60, box.y - radius + e), point(box.x + box.w + 60, box.y - radius + e), radius]);
    out.push([point(box.x + box.w + radius + e, box.y - 60), point(box.x + box.w + radius + e, box.y + box.h + 60), radius]);
  }
  out.push([point(box.x - 80, cy), point(cx, cy), radius]);
  out.push([point(cx, cy), point(cx + 30, cy + 7), radius]);
  const lean = ((index % 7) - 3) * 9;
  out.push([point(box.x - 1500, cy + lean), point(box.x + box.w + 1500, cy - lean), radius]);
  return out;
}

test('the core sweeps the arena\'s statics as geometryContact does, grazing and crossing every kind', () => {
  const map = generatedMap(), shapes = staticShapes(map, false), sweeps = [];
  const kinds = new Set();
  shapes.forEach((shape, i) => {
    kinds.add(shape.kind);
    if (i % 4 !== 0 && !(shape.kind === 'polygon' && i % 2 === 0)) return;
    sweeps.push(...aroundShape(shape, RADII[i % RADII.length], i));
  });
  assert.deepEqual([...kinds].sort(), ['circle', 'polygon', 'rect'], 'the arena has every kind');
  const next = random(7);
  for (let i = 0; i < 600; i++) {
    const a = point(next() * map.width, next() * map.height), b = point(a.x + (next() - 0.5) * 3000, a.y + (next() - 0.5) * 3000);
    sweeps.push([a, b, RADII[i % RADII.length]]);
  }
  const { found, clear } = check('statics', map, sweeps);
  assert.ok(found > 0 && clear > 0, `found ${found}, clear ${clear}`);
  // Sweeps that end exactly where the first contact is, and start there.
  const ends = [];
  for (const [a, b, radius] of sweeps.slice(0, 600)) {
    const t = geometryContact(map, false, a, b, radius);
    if (t === Infinity) continue;
    const end = point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    ends.push([a, end, radius], [end, b, radius]);
  }
  const touching = check('ends', map, ends);
  assert.ok(touching.found > 0, `touching ${touching.found}`);
});

test('the core reads the gates\' open mask live between calls', () => {
  const map = generatedMap(), { gates } = sweptUpload(map);
  assert.ok(gates.length > 0);
  let found = 0, clear = 0;
  for (let phase = 0; phase < 3; phase++) {
    map.gates.forEach((gate, i) => { gate.open = (i + phase) % 3 === 0; });
    const sweeps = [];
    gates.forEach((shape, i) => { sweeps.push(...aroundShape(shape, RADII[(i + phase) % RADII.length], i)); });
    const result = check(`gates, phase ${phase}`, map, sweeps);
    found += result.found; clear += result.clear;
  }
  assert.ok(found > 0 && clear > 0, `found ${found}, clear ${clear}`);
});

test('the core sweeps extra shapes in order after the map\'s: rotated polygons and circles', () => {
  const map = generatedMap(), shapes = staticShapes(map, false), next = random(11), sweeps = [];
  for (let i = 0; i < 300; i++) {
    const base = bounds(shapes[(i * 13) % shapes.length]);
    const a = point(base.x - 400 + next() * 800, base.y - 400 + next() * 800), b = point(a.x + (next() - 0.5) * 1200, a.y + (next() - 0.5) * 1200);
    const extra = [];
    for (let k = 0; k < 4; k++) {
      const x = a.x + (b.x - a.x) * next(), y = a.y + (b.y - a.y) * next() + (next() - 0.5) * 20 + (i % 3) * 400;
      extra.push(k % 2
        ? bodyShape({ x, y, angle: (next() - 0.5) * 6, shape: { kind: 'box', hx: 4 + next() * 20, hy: 2 + next() * 12 } })
        : bodyShape({ x, y, angle: 0, shape: { kind: 'circle', radius: 3 + next() * 15 } }));
    }
    extra.push(bodyShape({ x: a.x + 300 + (i % 3) * 400, y: a.y, angle: 1.3, shape: { kind: 'convex', vertices: [point(-10, -8), point(12, -6), point(4, 14)] } }));
    sweeps.push([a, b, RADII[i % RADII.length], extra]);
  }
  const onMap = check('extras', map, sweeps);
  // With the map's own shapes out of the way some sweeps clear the extras.
  const bare = check('bare extras', { ...map, obstacles: [], gates: [] }, sweeps);
  assert.ok(onMap.found > 0 && bare.found > 0 && bare.clear > 0, `on map ${onMap.found}, bare ${bare.found} found ${bare.clear} clear`);
});

test('the core reads degenerate segments and repeated points as SAT does', () => {
  const map = { ...generatedMap(), obstacles: [], gates: [] };
  const polygons = [
    { kind: 'polygon', x: 100, y: 100, points: [point(0, 0), point(0, 0), point(40, 0), point(40, 0), point(0, 40), point(0, 0)] },
    { kind: 'polygon', x: 300, y: 100, points: [point(0, 0), point(30, 0)] },
    { kind: 'polygon', x: 500, y: 100, points: [point(5, 5)] },
    { kind: 'polygon', x: -0, y: 300, points: [point(-0, 0), point(20, 0), point(20, 20), point(0, 20)] },
    { kind: 'rect', x: 100, y: 300, w: 0, h: 40 },
    { kind: 'circle', x: 300, y: 300, r: 0 },
  ];
  const sweeps = [];
  for (const shape of polygons) {
    const box = bounds(shape);
    for (const radius of RADII) {
      sweeps.push([point(box.x - 500, box.y - 500), point(box.x - 480, box.y - 500), radius, [shape]]);
      for (const [dx, dy] of [[0, 0], [1, 0], [-3, 7], [20, 20], [40, 0]]) {
        const a = point(box.x + dx, box.y + dy);
        sweeps.push([a, a, radius, [shape]], [a, point(a.x + 50, a.y), radius, [shape]], [point(a.x - 50, a.y - 50), a, radius, [shape]]);
      }
    }
  }
  const { found, clear } = check('degenerate', map, sweeps);
  assert.ok(found > 0 && clear > 0, `found ${found}, clear ${clear}`);
});

test('the core reads the world\'s solid props as solidContact does, rotated and moved', async () => {
  const { createGame, disposePhysics } = await import('../shared/simulation.ts');
  const { contentById } = await import('../shared/simulation/content.ts');
  const { physicsRuntime } = await import('../shared/simulation/physics-runtime.ts');
  const { sightOf } = await import('../shared/simulation/sight-runtime.ts');
  const { solidContact } = await import('../shared/simulation/swept.ts');
  const { openArea } = await import('./helpers/arena.js');
  const map = { seed: 439, width: 800, height: 800, playableArea: openArea(800, 800, 100), buildings: [], obstacles: [], gates: [],
    hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 250, y: 700 }], hunterSpawns: [{ x: 150, y: 700 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: ['C0'], gladiators: [{ name: 'G', kit: 'hook' }] };
  const s = await createGame(439, map, content);
  try {
    const world = physicsRuntime(s).world, next = random(1229), sweeps = [];
    const props = [[300, 300, 0], [420, 300, 0.7], [540, 300, -2.3], [300, 450, Math.PI / 2], [450, 450, 1e-9], [600, 450, 3]];
    props.forEach(([x, y], i) => world.queueAddBody({ id: `prop:p${i}`, kind: 'prop', shape: { kind: 'box', hx: 10 + i, hy: 15 }, x, y, mass: 1 }));
    world.commitMutations();
    props.forEach(([x, y, angle], i) => world.setTransform(`prop:p${i}`, { x, y, angle }));
    for (const [x, y] of props) for (let k = 0; k < 40; k++) {
      const angle = next() * Math.PI * 2, reach = 10 + next() * 30, from = 40 + next() * 40;
      const a = { x: x + Math.cos(angle) * from, y: y + Math.sin(angle) * from };
      sweeps.push([a, { x: x + Math.cos(angle) * (from - reach * 3), y: y + Math.sin(angle) * (from - reach * 3) }, RADII[k % RADII.length]]);
      sweeps.push([a, { x: a.x + Math.sin(angle) * 80, y: a.y - Math.cos(angle) * 80 }, RADII[k % RADII.length]]);
    }
    const { core, world: native } = world.boundaryCall(), misses = [];
    let found = 0, clear = 0;
    for (const [a, b, radius] of sweeps) {
      const handles = sightOf(s).queryHandles(s.map), swept = sightOf(s).sweptHandle(s.map);
      const want = solidContact(s, a, b, radius), got = core.physics_solid_contact(native, swept, handles.gates, a.x, a.y, b.x, b.y, radius);
      if (want === Infinity) clear++; else found++;
      if (!Object.is(want, got) && misses.push({ a, b, radius, want, got }) >= 5) break;
    }
    assert.deepEqual(misses, [], 'core and TypeScript differ on the world\'s props');
    assert.ok(found > 50 && clear > 50, `both sides exercised (found ${found}, clear ${clear})`);
  } finally { disposePhysics(s); }
});

test('a map spread over the same obstacles gets its own upload when its extent, playable area or gates differ', () => {
  const map = generatedMap(), next = random(1243);
  const box = bounds(staticShapes(map, false)[0]);
  // Each variant keeps `map.obstacles`, the upload's cache key, and changes something the upload reads.
  const cells = map.playableArea.rows.slice(0, Math.floor(map.playableArea.rows.length / 2));
  const variants = [
    { ...map },
    { ...map, width: map.width + 400, height: map.height + 400 },
    { ...map, playableArea: { ...map.playableArea, rows: cells } },
    { ...map, gates: map.gates.map(g => ({ ...g, x: g.x + 7 })) },
    { ...map, gates: map.gates.slice(1).concat(map.gates.slice(0, 1)) },
  ];
  const sweeps = [];
  for (let i = 0; i < 300; i++) {
    const a = { x: next() * map.width, y: next() * map.height }, angle = next() * Math.PI * 2, reach = 50 + next() * 900;
    sweeps.push([a, { x: a.x + Math.cos(angle) * reach, y: a.y + Math.sin(angle) * reach }, RADII[i % RADII.length]]);
  }
  sweeps.push([{ x: box.x - 50, y: box.y + box.h / 2 }, { x: box.x + box.w + 50, y: box.y + box.h / 2 }, 0]);
  // Interleaved, so a stale handle from the variant before would answer.
  for (let round = 0; round < 2; round++) for (const [k, variant] of variants.entries()) {
    const { found } = check(`variant ${k}, round ${round}`, variant, sweeps);
    assert.ok(found > 0, `variant ${k} meets geometry`);
  }
});
