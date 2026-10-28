import { portalMargin } from '../map/micro/hints.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle } from '../shared/shape.ts';
import { designsNotUsed } from '../map/micro/building/draw.ts';
import { cellsOf } from './helpers/cells.js';
import { assertWithinBudget } from './helpers/budget.js';

const SIZE = 40;
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'depot', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides. */
const MASKS = {
  yard: [cellsOf(14, 12), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 14, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 12, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const blockers = result => result.elements.flatMap(element => elementShapes(element));
/** An element's box in cells. */
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });

test('a depot region keeps the portal promise over seeds, masks and parameters', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [undefined, { density: 1, roomCells: 6 }, { density: 0.3, roomCells: 12 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      if (name !== 'yard') assert.ok(result.elements.length > 0, `${name} seed ${seed} stood warehouses or rows`);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
});

test('depots are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('every piece keeps an aisle from the next and from the region\'s edge, all on one axis', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) {
    const input = brief(name, seed, cells, portals, { density: 1, roomCells: 6 });
    const result = buildRegion(input), mask = createRegionMask(input), boxes = result.elements.map(cellBox);
    const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
    for (const [i, box] of boxes.entries()) {
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

test('a macro-sized depot with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals));
  assertWithinBudget(performance.now() - started, 3000, 'macro depot built');
  assert.ok(result.manifest.warehouses > 10 && result.manifest.rows > 100);
  assert.ok(bounds(blockers(result)[0]).w > 0);
});

test('depot can place geometry against a hinted edge while protecting portals', () => {
  const cells = cellsOf(40, 30);
  const portals = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 10, length: 3 }];
  const hints = [{ axis: 'h', x: 0, y: 0, length: 40 }];
  const input = { ...brief('hinted', 1, cells, portals, { density: 1 }), hints };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.y === 0), 'a piece reaches the hinted north edge');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('large concave depot with many portals keeps a safe hinted attachment', () => {
  const cells = cellsOf(80, 30, (x, y) => y < 15 || x < 45);
  const portals = Array.from({ length: 33 }, (_, i) => ({ id: `north-${i}`, axis: 'h', x: i * 2, y: 0, length: 2 }));
  portals.push({ id: 'south', axis: 'h', x: 8, y: 30, length: 2 });
  const input = { ...brief('many-concave', 4, cells, portals, { density: 1 }), hints: [{ axis: 'v', x: 0, y: 17, length: 12 }] };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.x === 0), 'a piece reaches the hinted west edge');
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
