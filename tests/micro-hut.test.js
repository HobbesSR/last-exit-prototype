import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { createRegionMask, elementShapes, findRegionRoute, travelClear } from '../map/micro/geometry.ts';
import { circle, overlaps } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, extra = {}) => ({ id, seed, type: 'hut', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals, ...extra });

/** 52's worked case, then masks with portals on several sides: a yard, an L, and a ring around a hole. */
const MASKS = {
  worked: [cellsOf(6, 6), [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }, { id: 'east', axis: 'v', x: 6, y: 3, length: 2 }]],
  yard: [cellsOf(10, 8), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 10, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 4, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 5, length: 2 }]],
  ell: [cellsOf(12, 12, (x, y) => y < 6 || x < 6), [{ id: 'east', axis: 'v', x: 12, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 12, length: 3 },
    { id: 'corner', axis: 'h', x: 7, y: 6, length: 4 }]],
  ring: [cellsOf(14, 14, (x, y) => x < 5 || x >= 9 || y < 5 || y >= 9), [{ id: 'north', axis: 'h', x: 6, y: 0, length: 2 },
    { id: 'hole', axis: 'v', x: 9, y: 6, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 10, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const house = result => result.elements.find(element => element.template.encloses);
const blockers = (result, doors = false) => result.elements.flatMap(element => elementShapes(element, doors));

test('the design-based hut preserves complete L1 output at every door orientation and several cell sizes', () => {
  // Captured from 21425fd before L2: geometry, part order, placement, loot and manifest.
  const hash = createHash('sha256'), sides = new Set();
  for (const cellSize of [1, 7, 40, 53]) for (let seed = 1; seed <= 16; seed++) {
    const cells = cellsOf(10, 10);
    const result = buildRegion(brief('l2-compatibility', seed, cells, [], { cellSize }));
    const gate = house(result).template.parts.find(part => part.part === 'gate');
    sides.add(gate.x < cellSize ? 'W' : gate.x > 3 * cellSize ? 'E' : gate.y < cellSize ? 'N' : 'S');
    hash.update(JSON.stringify(result));
  }
  assert.deepEqual([...sides].sort(), ['E', 'N', 'S', 'W']);
  assert.equal(hash.digest('hex'), 'cccf8d24e8727393b08733fb1492ee246a1fbddcd09c592a228116caceec177e');
});

test('a hut region keeps the portal promise over seeds and masks', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const result = buildRegion(brief(name, seed, cells, portals));
    assert.ok(house(result), `${name} ${seed} built a house`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
});

test('the house is reached through its door, and only through it', () => {
  const radius = hunterClearance(SIZE);
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const result = buildRegion(brief(name, seed, cells, portals)), building = house(result), mask = createRegionMask(result.brief);
    const gate = building.template.parts.find(part => part.part === 'gate');
    const centre = { x: building.x + building.template.w / 2, y: building.y + building.template.h / 2 };
    const door = { x: building.x + gate.x, y: building.y + gate.y };
    // The doorstep: a hunter's width beyond the door, away from the centre.
    const out = { x: door.x - Math.sign(centre.x - door.x) * (radius + 1) * (gate.h > gate.w ? 1 : 0), y: door.y - Math.sign(centre.y - door.y) * (radius + 1) * (gate.w > gate.h ? 1 : 0) };
    assert.ok(travelClear(mask, blockers(result), out, centre, radius), `${name} ${seed}: a hunter walks in through the door`);
    const from = portalStands(result.brief, mask)[0].points[0];
    assert.ok(findRegionRoute(mask, blockers(result), from, out, radius), `${name} ${seed}: the yard reaches the doorstep`);
    // Closed, the door seals the house: a contestant inside can't get out.
    assert.equal(findRegionRoute(mask, blockers(result, true), centre, from, 1), null, `${name} ${seed}: the house is enclosed`);
  }
});

test('the house has walls, one door, a window opposite and a roof (52\'s worked case)', () => {
  const [cells, portals] = MASKS.worked;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('worked', seed, cells, portals)), building = house(result);
    assert.equal(result.elements.length, 1);
    assert.equal(building.template.encloses, true);
    assert.equal(building.template.w, 4 * SIZE);
    const parts = building.template.parts, gates = parts.filter(p => p.part === 'gate'), windows = parts.filter(p => p.kind === 'window');
    assert.equal(gates.length, 1);
    assert.equal(windows.length, 1);
    assert.equal(Math.max(gates[0].w, gates[0].h), 2 * SIZE, 'a doorway wide');
    const centre = building.template.w / 2, w = windows[0].shape;
    // Opposite: the window and the door sit on either side of the centre along the same axis.
    const doorAxisX = gates[0].h > gates[0].w;
    if (doorAxisX) assert.ok(Math.sign(gates[0].x - centre) === -Math.sign(w.x + w.w / 2 - centre));
    else assert.ok(Math.sign(gates[0].y - centre) === -Math.sign(w.y + w.h / 2 - centre));
    assert.deepEqual(result.manifest, { cells: 36, structures: 1, obstacles: parts.filter(p => p.part === 'obstacle').length, gates: 1,
      loot: result.loot.length, coreElements: 0 });
  }
});

test('a region with no box that keeps the promise is open, the last resort (17 M24)', () => {
  const open = (cells, portals) => {
    const result = buildRegion(brief('small', 1, cells, portals));
    assert.deepEqual([result.elements, result.loot, result.coreElements], [[], [], []]);
  };
  open(cellsOf(2, 3), [{ id: 'north', axis: 'h', x: 0, y: 0, length: 2 }]);
  open(cellsOf(5, 5), []);
  // Narrower than 6 on one axis (54): a 4 × 4 box and its doorstep would fit, but the region is too small.
  for (const [w, h] of [[4, 6], [5, 6], [6, 4], [6, 5], [5, 12]]) open(cellsOf(w, h), [{ id: 'south', axis: 'h', x: 0, y: h, length: 2 }]);
  // Every side has a portal, so every 4 × 4 box would stand on an approach.
  open(cellsOf(6, 6), [{ id: 'n', axis: 'h', x: 2, y: 0, length: 2 }, { id: 's', axis: 'h', x: 2, y: 6, length: 2 },
    { id: 'w', axis: 'v', x: 0, y: 2, length: 2 }, { id: 'e', axis: 'v', x: 6, y: 2, length: 2 }]);
  // The only boxes would cut the one 4-wide neck joining the two portals. The nub makes the region 6 tall without room for a box.
  open(cellsOf(14, 6, (x, y) => y < 4 || x < 2), [{ id: 'w', axis: 'v', x: 0, y: 1, length: 2 }, { id: 'e', axis: 'v', x: 14, y: 1, length: 2 }]);
});

test('a hut is deterministic in its seed', () => {
  const [cells, portals] = MASKS.yard;
  assert.deepEqual(buildRegion(brief('yard', 7, cells, portals)), buildRegion(brief('yard', 7, cells, portals)));
  const sites = new Set(SEEDS.map(seed => { const b = house(buildRegion(brief('yard', seed, cells, portals))); return `${b.x},${b.y}`; }));
  assert.ok(sites.size > 1, 'seeds move the house');
});

test('loot follows each cell\'s zone, one per cell, clear of the walls and the door', () => {
  const [cells, portals] = MASKS.yard, mask = createRegionMask({ cells, cellSize: SIZE });
  const inner = cells.filter(c => c.x >= 5), outer = cells.filter(c => c.x < 5);
  const zones = [{ tier: 4, bonus: 0, lootChance: 1, cells: inner }, { tier: 1, bonus: 0, lootChance: 0, cells: outer }];
  let inside = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('yard', seed, cells, portals, { zones })), shapes = blockers(result, true), building = house(result);
    const keys = result.loot.map(l => `${Math.floor(l.x / SIZE)},${Math.floor(l.y / SIZE)}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(result.loot.length);
    for (const loot of result.loot) {
      assert.equal(loot.tier, 4);
      assert.ok(loot.x >= 5 * SIZE);
      const disc = circle(loot.x, loot.y, 27);
      assert.ok(mask.contains(disc) && !shapes.some(shape => overlaps(disc, shape)));
      if (loot.x > building.x && loot.x < building.x + building.template.w && loot.y > building.y && loot.y < building.y + building.template.h) inside++;
    }
  }
  assert.ok(inside, 'some loot lands inside a house');
});

test('core elements asked of a hut are left for the report to name', () => {
  const [cells, portals] = MASKS.worked;
  const result = buildRegion(brief('worked', 1, cells, portals, { coreElements: { spawn: 2 } }));
  assert.deepEqual(result.coreElements, []);
  assert.equal(result.manifest.coreElements, 0);
});

test('a macro-sized hut region with hundreds of portals builds in bounded time', () => {
  // A 172 × 172 field with a 2-cell portal every 3 cells around its edge.
  const cells = cellsOf(172, 172), portals = [];
  for (let i = 0; i + 2 <= 172; i += 3) portals.push({ id: `n${i}`, axis: 'h', x: i, y: 0, length: 2 }, { id: `s${i}`, axis: 'h', x: i, y: 172, length: 2 },
    { id: `w${i}`, axis: 'v', x: 0, y: i, length: 2 }, { id: `e${i}`, axis: 'v', x: 172, y: i, length: 2 });
  const start = performance.now(), result = buildRegion(brief('field', 3, cells, portals));
  const elapsed = performance.now() - start;
  assert.ok(house(result));
  assert.ok(portals.length > 200 && cells.length > 29000);
  assert.ok(elapsed < 2000, `${Math.round(elapsed)} ms`);
});

test('an observer sees the house its element was realized from, and changes nothing', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const traces = [], result = buildRegion(brief(name, seed, cells, portals), undefined, trace => traces.push(trace));
    assert.deepEqual(result, buildRegion(brief(name, seed, cells, portals)), `${name} ${seed}`);
    assert.equal(traces.length, 1);
    const [trace] = traces, building = house(result);
    assert.equal(trace.label, building.label);
    assert.deepEqual(trace.origin, { x: building.x, y: building.y });
    assert.deepEqual(trace.realization.template, building.template);
    assert.deepEqual(trace.design.connections.map(c => c.id), ['door', 'window']);
    assert.equal(trace.allocation.spaces[0].cells.length, 16);
    assert.equal(trace.realization.openings.length, building.template.parts.filter(p => p.part === 'gate' || p.kind === 'window').length);
  }
  // A region too small for a house goes to `open`, which reports no building.
  const traces = [];
  buildRegion(brief('small', 1, cellsOf(5, 5), []), undefined, trace => traces.push(trace));
  assert.deepEqual(traces, []);
});
