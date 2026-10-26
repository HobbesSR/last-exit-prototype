import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';
import { assertWithinBudget } from './helpers/budget.js';

const SIZE = 40;
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'compound', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A yard just big enough, a wide field, an L, and a ring around a hole, with portals on several sides. */
const MASKS = {
  yard: [cellsOf(17, 16), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 17, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 16, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(40, 40, (x, y) => y < 20 || x < 20), [{ id: 'east', axis: 'v', x: 40, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 40, length: 4 },
    { id: 'corner', axis: 'h', x: 24, y: 20, length: 6 }]],
  ring: [cellsOf(46, 46, (x, y) => x < 17 || x >= 29 || y < 17 || y >= 29), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 29, y: 20, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 34, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PARAMETERS = [undefined, { gates: 1 }, { gates: 3 }, { gates: 4 }];
// These repeated seeds also appear in the portal, ring and trace checks.
const built = new Map();
const build = input => {
  const key = JSON.stringify(input);
  if (!built.has(key)) built.set(key, buildRegion(input));
  return built.get(key);
};
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const ringElements = result => result.elements.filter(element => /^compound-(room|gate)/.test(element.label));
/** An element's box in cells. */
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
/** The compound's ring box in cells; delegated exterior pieces do not change it. */
const compoundBox = result => {
  const boxes = ringElements(result).map(cellBox);
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};

test('a compound region keeps the portal promise over seeds, masks and gate counts', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) for (const parameters of PARAMETERS) {
    const result = build(brief(name, seed, cells, portals, parameters));
    assert.ok(result.manifest.rooms >= 4, `${name} seed ${seed} stood a compound`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
  }
});

test('a hinted perimeter can hold the ring without blocking portal or gate access', () => {
  const cells = cellsOf(18, 18), portals = [{ id: 'south', axis: 'h', x: 7, y: 18, length: 3 }];
  const input = { ...brief('hinted', 3, cells, portals), hints: [{ axis: 'h', x: 0, y: 0, length: 18 }] };
  const result = build(input), box = compoundBox(result);
  assert.equal(box.y, 0);
  assert.ok(result.manifest.rooms >= 4);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
});

test('a 24 by 18 yard keeps an intermediate ring size between its portals', () => {
  const cells = cellsOf(24, 18), portals = [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
    { id: 'east', axis: 'v', x: 24, y: 8, length: 2 },
  ];
  for (const seed of [1, 2, 3, 4]) {
    const result = build(brief(`fill-${seed}`, seed, cells, portals));
    const box = compoundBox(result);
    assert.ok(box.w * box.h >= 240, `${seed}: ${box.w} by ${box.h} ring`);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
  }
});

test('compounds are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = build(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('one compound has roofed rooms around a clear court and its gates', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) for (const parameters of PARAMETERS) {
    const input = brief(name, seed, cells, portals, parameters);
    const result = build(input), box = compoundBox(result);
    assert.ok(box.w >= 10 && box.h >= 10 && box.w <= 24 && box.h <= 24, `${name} ${seed}: ${box.w} × ${box.h}`);
    const court = rect((box.x + 3) * SIZE, (box.y + 3) * SIZE, (box.w - 6) * SIZE, (box.h - 6) * SIZE);
    assert.ok(result.elements.flatMap(element => elementShapes(element, true)).every(shape => !shapesOverlap(court, shape)), `${name} ${seed}: clear court`);
    const gates = ringElements(result).filter(element => element.label.startsWith('compound-gate'));
    assert.equal(gates.length, parameters?.gates ?? 2);
    assert.equal(result.manifest.compoundGates, gates.length);
    for (const room of ringElements(result).filter(element => element.label.startsWith('compound-room'))) {
      assert.equal(room.template.encloses, true);
      assert.ok(room.template.parts.some(part => part.part === 'gate'), `${room.label} has a door`);
    }
  }
});

test('compounds roll loot by zone and keep every site clear of walls and doors', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals);
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 17) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 17) }];
  const result = build(input), mask = createRegionMask(input);
  const shapes = result.elements.flatMap(element => elementShapes(element, true));
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 17 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
});

test('a compound checks its gate count, and a region too narrow for its court goes empty', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 0 })), /gates/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 5 })), /gates/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { gates: 1.5 })), /gates/);
  const thin = buildRegion(brief('thin', 1, cellsOf(40, 9), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(thin.manifest.rooms ?? 0, 0);
  assert.equal(thin.elements.length, 0);
});

test('a macro-sized compound with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals, { gates: 4 }));
  assertWithinBudget(performance.now() - started, 3000);
  const box = compoundBox(result);
  assert.deepEqual([box.w, box.h], [24, 24]);
});

test('the ring is one design: an observer sees it, and every room has an opening into the court or a neighbour', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) for (const parameters of PARAMETERS) {
    const traces = [], input = brief(name, seed, cells, portals, parameters);
    const result = buildRegion(input, undefined, trace => traces.push(trace));
    assert.deepEqual(result, build(input), `${name} ${seed}: observing changes nothing`);
    assert.equal(traces.length, 1);
    const [{ label, design, allocation, realization, origin }] = traces;
    assert.equal(label, 'compound');
    assert.deepEqual(realization.misses, []);
    assert.deepEqual(ringElements(result).map(e => e.label), allocation.spaces.map(s => `compound-${s.id}`));
    assert.equal(design.spaces.filter(s => s.id.startsWith('room')).length, result.manifest.rooms);
    // The ring's footprint is the compound's box less its court.
    const box = compoundBox(result);
    assert.deepEqual(origin, { x: box.x * SIZE, y: box.y * SIZE });
    assert.equal(allocation.footprint.length, box.w * box.h - (box.w - 6) * (box.h - 6));
    for (const space of design.spaces) assert.ok(realization.openings.some(o => o.a === space.id || o.b === space.id), `${name} ${seed}: ${space.id} has an opening`);
  }
});
