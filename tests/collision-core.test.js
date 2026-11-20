import test from 'node:test';
import assert from 'node:assert/strict';
import { canOccupy } from '../shared/movement.ts';
import { lineClear, reachClear, seeThrough } from '../shared/sight.ts';
import { insideMap, playableAreaFromCells } from '../shared/playable-area.ts';
import { bounds, shapeOf } from '../shared/shape.ts';
import { diskPenetration } from '../shared/shape-queries.ts';
import { gateShape } from '../shared/gate-index.ts';
import { coreSight, initCoreSight } from '../shared/sight-core.ts';
import { generatedMap } from './helpers/room-harness.js';

// The core's collision queries are ports of `canOccupy` (shared/movement.ts) and `lineClear` and `reachClear`
// (shared/sight.ts), which keep their JavaScript callers until #1234 moves them. So the two copies are held
// equal here (#1233, docs/27 "Step 5b.2"), as the roof rule is in tests/discovery.test.js: on the room
// arena's 3,477 obstacles and 90 gates, at the places where the tolerances, the playable area's edges and
// the SAT regions decide, with gates opened and closed between calls, and through the failure paths.

const sight = await initCoreSight();
const RADII = [0, 12, 15, 16, 24];

/** A fixed sequence in [0, 1), so a failure names a case that repeats. */
function random(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Points at a box's sides and corners, `r` out from them and within a hair of that, where contact and the 0.01 tolerance decide. */
function around(box, r) {
  const out = [], cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  for (const d of [-0.5, -0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02, 0.5]) {
    out.push([box.x - r - d, cy], [box.x + box.w + r + d, cy], [cx, box.y - r - d], [cx, box.y + box.h + r + d]);
    const k = (r + d) / Math.SQRT2;
    out.push([box.x - k, box.y - k], [box.x + box.w + k, box.y + box.h + k], [box.x + box.w + k, box.y - k], [box.x - k, box.y + box.h + k]);
  }
  out.push([cx, cy], [box.x, box.y], [box.x + box.w, box.y + box.h]);
  return out;
}

/** Compare the cases, collecting the first few that differ so a failure names them. */
function compare(label, cases, expected, actual) {
  const misses = [];
  let yes = 0;
  for (const c of cases) {
    const want = expected(...c), got = actual(...c);
    // A clear answer, or a depth: -1 is apart.
    if (want === true || (typeof want === 'number' && want >= 0)) yes++;
    if (!Object.is(want, got) && misses.push({ case: c, want, got }) >= 5) break;
  }
  assert.deepEqual(misses, [], `${label}: core and TypeScript differ`);
  return { yes, no: cases.length - yes };
}

test('the core\'s disk test reads every collider as SAT does, depth for depth', () => {
  const map = generatedMap(), cases = [];
  map.obstacles.forEach((o, i) => {
    const box = bounds(shapeOf(o));
    for (const [x, y] of around(box, RADII[i % RADII.length])) cases.push([i, x, y, RADII[(i + cases.length) % RADII.length]]);
  });
  const shapes = map.obstacles.map(shapeOf);
  const { yes } = compare('depth', cases,
    (i, x, y, r) => diskPenetration(x, y, r, shapes[i])?.depth ?? -1,
    (i, x, y, r) => sight.colliderDepth(map, i, x, y, r));
  assert.ok(yes > 50_000 && cases.length - yes > 20_000, `touching ${yes} of ${cases.length}`);
});

test('the core reads SAT\'s corner cases as SAT does: circles, merged points, flat boxes, signed zeros', () => {
  const shapes = [
    { x: 100, y: 100, w: 0, h: 40 },
    { x: -0, y: 200, w: 30, h: 30 },
    { x: 300, y: 300, w: 10, h: 10, r: 25 },
    { x: 400, y: 100, w: 40, h: 40, points: [{ x: 0, y: 0 }, { x: -0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 40, y: 40 }, { x: 0, y: 0 }] },
    { x: 500, y: 300, w: 30, h: 30, points: [{ x: 15, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }] },
    { x: 600, y: 100, w: 0, h: 0, points: [{ x: 5, y: 5 }] },
  ];
  const map = { width: 800, height: 600, playableArea: playableAreaFromCells([{ x: 0, y: 0 }], 800), obstacles: shapes, gates: [] };
  const cases = [];
  shapes.forEach((o, i) => { for (const r of RADII) for (const [x, y] of around(bounds(shapeOf(o)), r)) cases.push([i, x, y, r]); });
  shapes.forEach((_, i) => { for (const r of RADII) cases.push([i, -0, -0, r], [i, -0, 215, r], [i, 1, 215, -0]); });
  compare('corner depth', cases, (i, x, y, r) => diskPenetration(x, y, r, shapeOf(shapes[i]))?.depth ?? -1, (i, x, y, r) => sight.colliderDepth(map, i, x, y, r));
});

test('the core answers canOccupy as movement does, over the map, at every obstacle and with each flag', () => {
  const map = generatedMap(), cases = [];
  for (let x = -40; x < map.width + 40; x += 97) for (let y = -40; y < map.height + 40; y += 89) cases.push([x, y, RADII[cases.length % RADII.length], cases.length % 4]);
  map.obstacles.forEach((o, i) => {
    const r = RADII[1 + i % (RADII.length - 1)];
    for (const [x, y] of around(bounds(shapeOf(o)), r)) cases.push([x, y, r, (cases.length + (seeThrough(o.kind) ? 2 : 0)) % 4]);
  });
  const { yes, no } = compare('canOccupy', cases,
    (x, y, r, flags) => canOccupy(map, x, y, r, (flags & 1) !== 0, (flags & 2) !== 0),
    (x, y, r, flags) => sight.canOccupy(map, x, y, r, (flags & 1) !== 0, (flags & 2) !== 0));
  assert.ok(yes > 20_000 && no > 20_000, `clear ${yes}, blocked ${no}`);
  const edges = [];
  for (let i = 0; i < 4000; i++) edges.push([(i * 4.32) % map.width, (i * 2.17) % map.height, RADII[i % RADII.length]]);
  compare('insideMap', edges, (x, y, r) => insideMap(map, x, y, r), (x, y, r) => sight.insideMap(map, x, y, r));
});

test('gate state is read live: opening or closing a gate between calls changes the core\'s answer as it does movement\'s', () => {
  const map = generatedMap();
  let changed = 0;
  for (const gate of map.gates) {
    const cases = around(gateShape(gate), 12).map(([x, y]) => [x, y]);
    const answers = [];
    for (const open of [false, true, false]) {
      gate.open = open;
      compare(`gate ${gate.id} ${open ? 'open' : 'closed'}`, cases, (x, y) => canOccupy(map, x, y, 12), (x, y) => sight.canOccupy(map, x, y, 12));
      answers.push(cases.map(([x, y]) => sight.canOccupy(map, x, y, 12)).join());
    }
    if (answers[0] !== answers[1]) changed++;
    assert.equal(answers[0], answers[2], `gate ${gate.id} closed again`);
  }
  assert.ok(changed > map.gates.length / 2, `gates whose state moved an answer: ${changed} of ${map.gates.length}`);
});

test('the core answers lineClear and reachClear as sight does, through windows and gates and with a gate ignored', () => {
  const map = generatedMap(), next = random(1233), cases = [];
  for (let i = 0; i < 12_000; i++) {
    const x = next() * map.width, y = next() * map.height, reach = i % 2 ? 400 : 3000;
    cases.push([{ x, y }, { x: x + (next() - 0.5) * reach, y: y + (next() - 0.5) * reach }, null]);
  }
  for (const o of map.obstacles) if (seeThrough(o.kind)) {
    const box = bounds(shapeOf(o)), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    cases.push([{ x: cx - 60, y: cy }, { x: cx + 60, y: cy }, null], [{ x: cx, y: cy - 60 }, { x: cx, y: cy + 60 }, null]);
  }
  for (const g of map.gates) {
    const box = gateShape(g), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    for (const ignore of [null, g.id]) cases.push([{ x: cx - 80, y: cy }, { x: cx + 80, y: cy }, ignore], [{ x: cx, y: cy - 90 }, { x: cx, y: cy + 90 }, ignore]);
  }
  cases.push([{ x: 50, y: 50 }, { x: 50.005, y: 50 }, null], [{ x: -300, y: -300 }, { x: -100, y: -250 }, null]);
  map.gates.forEach((g, i) => { g.open = i % 3 === 0; });
  const line = compare('lineClear', cases, (a, b, ignore) => lineClear(map, a, b, ignore), (a, b, ignore) => sight.lineClear(map, a, b, ignore));
  const reach = compare('reachClear', cases, (a, b) => reachClear(map, a, b), (a, b) => sight.reachClear(map, a, b));
  assert.ok(line.yes > 1000 && line.no > 1000, `lines clear ${line.yes}, blocked ${line.no}`);
  assert.ok(reach.yes < line.yes - 20, `windows stop hands: reach clear ${reach.yes}, line clear ${line.yes}`);
});

test('the failure paths agree: no playable area, grown lists, another area, and inputs off the number line', () => {
  const map = generatedMap();
  let x = 1000;
  while (!canOccupy(map, x, map.height / 2, 24)) x += 37;
  const clear = [x, map.height / 2];
  assert.ok(sight.canOccupy(map, clear[0], clear[1], 24));
  // A map without a playable area throws as movement does, and the map's upload survives it.
  const bare = { ...map, playableArea: undefined };
  assert.throws(() => canOccupy(bare, ...clear, 24), /no playableArea/);
  assert.throws(() => sight.canOccupy(bare, ...clear, 24), /no playableArea/);
  assert.ok(sight.canOccupy(map, ...clear, 24));
  // An obstacle list that grows is uploaded again.
  map.obstacles.push({ x: clear[0] - 5, y: clear[1] - 5, w: 10, h: 10, kind: 'crate' });
  assert.equal(sight.canOccupy(map, ...clear, 24), canOccupy(map, ...clear, 24));
  assert.equal(sight.canOccupy(map, ...clear, 24), false);
  map.obstacles.pop();
  // A gate list that grows is too, and the new gate blocks while closed.
  map.gates.push({ ...map.gates[0], id: 'grown', x: clear[0], y: clear[1], open: false });
  assert.equal(sight.canOccupy(map, ...clear, 24), false);
  assert.equal(canOccupy(map, ...clear, 24), false);
  map.gates.pop();
  // The same obstacles over another playable area: a hole where the clear point was.
  const size = map.playableArea.cellSize, hole = [Math.floor(clear[0] / size), Math.floor(clear[1] / size)];
  const cells = [];
  for (let row = 0; row < Math.ceil(map.height / size); row++) for (let col = 0; col < Math.ceil(map.width / size); col++)
    if (insideMap(map, (col + 0.5) * size, (row + 0.5) * size) && (col !== hole[0] || row !== hole[1])) cells.push({ x: col, y: row });
  const holed = { ...map, gates: [], playableArea: playableAreaFromCells(cells, size) };
  for (const r of RADII) assert.equal(sight.canOccupy(holed, ...clear, r), canOccupy(holed, ...clear, r), `holed, radius ${r}`);
  assert.equal(sight.canOccupy(holed, ...clear, 0), false);
  assert.ok(sight.canOccupy(map, ...clear, 24), 'the original map keeps its own upload');
  const odd = [[NaN, 100, 12], [100, Infinity, 12], [clear[0], clear[1], -1], [clear[0], clear[1], NaN], [-0, -0, 0], [map.width, 100, 0], [100, map.height - 0.5, 0.5]];
  compare('odd inputs', odd, (x, y, r) => canOccupy(map, x, y, r), (x, y, r) => sight.canOccupy(map, x, y, r));
  const lines = [[{ x: NaN, y: 0 }, { x: 10, y: 10 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: -0, y: 5 }, { x: 0, y: 500 }]];
  compare('odd lines', lines, (a, b) => reachClear(map, a, b), (a, b) => sight.reachClear(map, a, b));
});

// Building a handle may grow WASM memory and detach the old buffer, so the open mask's view must be made
// after the calls that build, as every view is (docs/27). A stub core grows memory in each constructor and
// answers with the mask byte it finds, so a mask written into a detached buffer would read as closed.
test('a collision upload that grows the core memory still writes the open mask where the core reads it', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let heap = 64, mask = 0;
  const alloc = bytes => { const at = heap; heap += (bytes + 7) & ~7; return at; };
  const grow = handle => { memory.grow(1); return handle; };
  const stub = {
    memory, adapter_version: () => 9, core_alloc: alloc, core_free() {},
    gate_set_new: () => grow(16), gate_set_open: () => (mask = alloc(1)),
    collision_map_new: () => grow(24), collision_map_free() {},
    can_occupy: () => new Uint8Array(memory.buffer, mask, 1)[0],
  };
  const map = { width: 400, height: 400, playableArea: playableAreaFromCells([{ x: 0, y: 0 }], 400), obstacles: [], gates: [{ id: 'g', x: 200, y: 200, open: true }] };
  assert.equal(coreSight(stub).canOccupy(map, 100, 100, 12), true);
});
