import { portalMargin } from '../map/micro/hints.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle } from '../shared/shape.ts';
import { designsNotUsed } from '../map/micro/building/draw.ts';
import { cellsOf } from './helpers/cells.js';
import { MASKS, SEEDS, SIZE, assertDepotPromise, blockers, brief } from './helpers/depot-fixtures.js';
import { cordWork } from '../map/micro/cord-witness.ts';

/** An element's box in cells. */
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });

// The first seed on every mask under each parameter set; tests/slow/micro-depot-sweeps.test.js runs
// all eight. Determinism under another cell order is the builder contract's (micro-builder-contract)
// and the production witnesses' (micro-depot-routing) to show (#807).
test('a depot region keeps the portal promise over masks and parameters', () => assertDepotPromise(SEEDS.slice(0, 1)));

test('every piece keeps an aisle from the next and from the region\'s edge, all on one axis', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) {
    const input = brief(name, seed, cells, portals, { density: 1, roomCells: 6 });
    const result = buildRegion(input), mask = createRegionMask(input), access = createAccessMask(input), boxes = result.elements.map(cellBox);
    const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
    for (const [i, box] of boxes.entries()) {
      for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++)
        assert.ok(access.has(x, y), `${name} ${seed}: ${result.elements[i].label} has a complete local bypass`);
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++)
        assert.ok(mask.has(x, y) && !reserved.has(`${x},${y}`), `${name} ${seed}: ${result.elements[i].label} footprint`);
      for (const other of boxes.slice(i + 1)) {
        const gap = Math.max(other.x - (box.x + box.w), box.x - (other.x + other.w), other.y - (box.y + box.h), box.y - (other.y + other.h));
        assert.ok(gap >= 2, `${name} ${seed}: aisle ${gap}`);
      }
    }
    // Rows and warehouses share one long axis.
    const long = new Set(boxes.filter(box => box.w !== box.h).map(box => box.w > box.h ? 'x' : 'y'));
    assert.equal(long.size, 1, `${name} ${seed}: one axis`);
  }
});

test('warehouses are roofed designs, a way through with every space reached, and shelves on the floor', () => {
  const [cells, portals] = MASKS.field;
  const designs = new Set();
  let seen = 0;
  for (const seed of SEEDS) {
    const traces = new Map();
    const result = buildRegion(brief('field', seed, cells, portals, { density: 1, roomCells: 12 }), undefined, trace => traces.set(trace.label, trace));
    assert.equal(result.manifest.structures, result.manifest.warehouses);
    assert.equal(result.manifest.designed, traces.size);
    for (const element of result.elements.filter(e => e.label.startsWith('depot-warehouse'))) {
      seen++;
      const { w, h } = cellBox(element);
      assert.deepEqual([Math.max(w, h), Math.min(w, h)], [12, 9]);
      assert.equal(element.template.encloses, true);
      for (const gate of element.template.parts.filter(p => p.part === 'gate')) assert.equal(Math.max(gate.w, gate.h), 2 * SIZE);
      const trace = traces.get(element.label);
      assert.ok(trace, `${element.label} is a design`);
      assert.deepEqual(trace.origin, { x: element.x, y: element.y });
      designs.add(trace.design.spaces.map(space => space.id).join('+'));
      // At least two doors outside, and every space reached through doors from outside.
      const doors = trace.realization.openings.filter(o => o.kind === 'door');
      assert.ok(doors.filter(o => o.a === 'outside' || o.b === 'outside').length >= 2, `${element.label} is a way through`);
      const reached = new Set(['outside']);
      for (let grown = true; grown;) {
        grown = false;
        for (const { a, b } of doors) if (reached.has(a) !== reached.has(b)) { reached.add(a); reached.add(b); grown = true; }
      }
      assert.equal(reached.size, trace.design.spaces.length + 1);
      // Shelves stand inside the floor's cells.
      const floor = new Set(trace.allocation.spaces.find(space => space.id === 'floor').cells.map(c => `${c.x},${c.y}`));
      const shelves = element.template.parts.filter(p => p.kind === 'container');
      assert.ok(shelves.length > 0);
      for (const { shape } of shelves) {
        const box = bounds(shape);
        for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y + box.h]])
          assert.ok(floor.has(`${Math.floor(Math.min(x, box.x + box.w - 1) / SIZE)},${Math.floor(Math.min(y, box.y + box.h - 1) / SIZE)}`));
      }
    }
  }
  assert.ok(seen > 0);
  assert.deepEqual([...designs].sort(), ['floor+office', 'floor+office+store']);
});

test('a warehouse box too small for several spaces is one room with a door at each end, traced with why', () => {
  const [cells, portals] = MASKS.field;
  const traces = new Map();
  const result = buildRegion(brief('field', 1, cells, portals, { density: 1, roomCells: 6 }), undefined, trace => traces.set(trace.label, trace));
  const warehouses = result.elements.filter(e => e.label.startsWith('depot-warehouse'));
  assert.ok(warehouses.length > 0, 'warehouses were built');
  assert.equal(result.manifest.warehouses, warehouses.length);
  assert.equal(result.manifest.designed, 0);
  assert.equal(traces.size, warehouses.length, 'every warehouse is traced');
  for (const element of warehouses) {
    const trace = traces.get(element.label);
    assert.deepEqual(trace.design.spaces.map(space => space.id), ['floor']);
    assert.equal(trace.realization.openings.filter(o => o.kind === 'door').length, 2);
    assert.equal(element.template.parts.filter(p => p.part === 'gate').length, 2);
    // Both designs with several spaces are named, each with its reason, and the lab shows them.
    assert.deepEqual(trace.rejected.map(r => r.design).sort(), ['floor+office', 'floor+office+store']);
    for (const { reason } of trace.rejected) assert.ok(reason.length > 0);
    assert.deepEqual(designsNotUsed(trace), trace.rejected.map(r => `Design not used: ${r.design}, ${r.reason}`));
  }
});

test('depots roll loot by zone and keep every site clear of walls, doors and containers', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals, { density: 1 });
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 15) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 15) }];
  const result = buildRegion(input), mask = createRegionMask(input);
  const shapes = result.elements.flatMap(element => elementShapes(element, true));
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 15 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
});

test('a depot checks its parameters, and a region with no contained 10 × 10 goes to open', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { roomCells: 5 })), /roomCells/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { roomCells: 7.5 })), /roomCells/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { density: 2 })), /density/);
  const empty = buildRegion(brief('field', 1, cells, portals, { density: 0 }));
  assert.equal(empty.elements.length, 0);
  const thin = buildRegion(brief('thin', 1, cellsOf(40, 9), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(thin.manifest.rows, undefined);
  assert.equal(thin.elements.length, 0);
});

/** A `w` × `h` depot with a two-cell portal every `step` cells along all four sides. */
const portalled = (w, h, step) => {
  const portals = [];
  for (let x = 2; x < w - 4; x += step) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: h, length: 2 });
  for (let y = 2; y < h - 4; y += step) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: w, y, length: 2 });
  return brief('portalled', 3, cellsOf(w, h), portals);
};

// The cost witness that runs every time (31, "A test's cost is part of the change"): counts, not
// a duration. 104 portals take 4 cord searches, each with a whole-region mesh. When the witness
// outgrew a fixed point limit, every later commit failed as `budget` and `commitEach` split it
// into more whole-region proofs (#801). This region passes the old 16,384-point limit: with it
// the build took 98 meshes, so a limit set too low again fails here, in every run, for 1.6 s.
test('a many-portal depot proves its cord with few whole-region meshes', () => {
  const before = { ...cordWork };
  const result = buildRegion(portalled(125, 94, 4));
  assert.ok(result.manifest.warehouses > 20 && result.manifest.rows > 30, JSON.stringify(result.manifest));
  const calls = cordWork.calls - before.calls, meshes = cordWork.meshBuilds - before.meshBuilds;
  assert.ok(calls <= 12 && meshes <= 12, `cord searches ${calls}, meshes ${meshes}, ceiling 12 each (#801)`);
});

test('depot leaves a bypass at a hinted edge while protecting portals', () => {
  const cells = cellsOf(40, 30);
  const portals = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 10, length: 3 }];
  const hints = [{ axis: 'h', x: 0, y: 0, length: 40 }];
  const input = { ...brief('hinted', 1, cells, portals, { density: 1 }), hints };
  const result = buildRegion(input);
  assert.ok(result.elements.length > 0, 'depot still places content');
  assert.ok(result.elements.every(element => element.y >= 2 * SIZE), 'north boundary has a two-cell bypass');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('large concave depot with many portals leaves a safe hinted boundary', () => {
  const cells = cellsOf(80, 30, (x, y) => y < 15 || x < 45);
  const portals = Array.from({ length: 33 }, (_, i) => ({ id: `north-${i}`, axis: 'h', x: i * 2, y: 0, length: 2 }));
  portals.push({ id: 'south', axis: 'h', x: 8, y: 30, length: 2 });
  const input = { ...brief('many-concave', 4, cells, portals, { density: 1 }), hints: [{ axis: 'v', x: 0, y: 17, length: 12 }] };
  const result = buildRegion(input);
  assert.ok(result.elements.length > 0, 'depot still places content');
  assert.ok(result.elements.every(element => element.x >= 2 * SIZE), 'west boundary has a two-cell bypass');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('thin rectangular depot keeps a hunter aisle between opposite sides', () => {
  const cells = cellsOf(10, 18);
  const portals = [{ id: 'north', axis: 'h', x: 1, y: 0, length: 2 },
    { id: 'south', axis: 'h', x: 1, y: 18, length: 2 }];
  const input = brief('thin', 7, cells, portals, { density: 1, roomCells: 6 });
  const result = buildRegion(input);
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
  for (const element of result.elements) {
    const x = element.x / SIZE, width = element.template.w / SIZE;
    assert.ok(x >= 2 || 10 - x - width >= 2, `${element.label} leaves an aisle on one side`);
  }
});
