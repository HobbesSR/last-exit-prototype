import { portalMargin } from '../map/micro/hints.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, shapesOverlap, shapesShareArea } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle, overlaps } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';
import { assertWithinBudget } from './helpers/budget.js';
import { SIZE, brief, MASKS, SEEDS, blockers, kind, gapOf } from './helpers/plant-fixtures.js';
import { assertPlantPromise } from './helpers/plant-promise.js';

const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

// The fast tier runs two seeds; tests/slow/micro-plant-promise.test.js runs them all.
test('a plant region keeps the portal promise over seeds, masks and parameters', () => assertPlantPromise(SEEDS.slice(0, 2)));

test('plants are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('machines and the shed keep an aisle from each other and respect portal margins, and pipes from all but what they join', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [{ density: 1, shed: 0 }, { density: 1, shed: 1 }]) {
      const input = brief(name, seed, cells, portals, parameters);
      const result = buildRegion(input), mask = createRegionMask(input);
      const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
      const solid = result.elements.filter(e => !kind('pipe')(e)).map(e => ({ label: e.label, box: cellBox(e) }));
      for (const [i, { label, box }] of solid.entries()) {
        for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++)
          assert.ok(mask.has(x, y) && !reserved.has(`${x},${y}`), `${name} ${seed}: ${label} footprint`);
        for (const other of solid.slice(i + 1)) assert.ok(gapBetween(box, other.box) >= 2, `${name} ${seed}: ${label} and ${other.label}`);
      }
      const cellsOfShape = shape => { const b = bounds(shape); return { x: b.x / SIZE, y: b.y / SIZE, w: b.w / SIZE, h: b.h / SIZE }; };
      const pipes = result.elements.filter(kind('pipe')).map(pipe => {
        const stubs = elementShapes(pipe).map(cellsOfShape);
        // A run's box reaches into the two machines it joins, though a gap against one leaves it no stub there.
        return { pipe, stubs, joins: solid.filter(({ box }) => gapBetween(cellBox(pipe), box) < 0) };
      });
      for (const { pipe, stubs, joins } of pipes) {
        // Each run joins exactly two machines, and keeps clear of every other piece, and of every run that shares neither.
        assert.equal(joins.length, 2, `${name} ${seed}: ${pipe.label} joins two machines`);
        assert.ok(joins.every(j => j.label.startsWith('plant-machine')));
        const others = [...solid.filter(s => !joins.includes(s)).map(s => s.box),
          ...pipes.filter(p => p.pipe !== pipe && !p.joins.some(j => joins.includes(j))).flatMap(p => p.stubs)];
        for (const s of stubs) for (const other of others)
          assert.ok(gapBetween(s, other) >= 2, `${name} ${seed}: ${pipe.label} keeps clear`);
      }
    }
});

test('pipe stubs end on the surfaces of the machines they join, chamfers included', () => {
  const [cells, portals] = MASKS.field;
  let ends = 0, cut = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals, { density: 1, shed: 0 }));
    const machines = result.elements.filter(kind('machine')).flatMap(m => elementShapes(m));
    for (const pipe of result.elements.filter(kind('pipe'))) {
      const pieces = elementShapes(pipe);
      cut += pieces.filter(piece => piece.kind === 'polygon').length;
      for (const piece of pieces) assert.ok(machines.every(m => !shapesShareArea(piece, m)), `${seed}: ${pipe.label} stays out of machines`);
      // Each machine the run joins is met by one of its stubs, flush: in contact, sharing no area.
      const met = machines.filter(m => pieces.some(piece => overlaps(piece, m)));
      ends += met.length;
      assert.ok(met.length >= 1 && met.length <= 2, `${seed}: ${pipe.label} meets its machines`);
    }
  }
  assert.ok(ends > 20 && cut > 0, `${ends} ends, ${cut} chamfer-cut pieces`);
});

test('pipe runs block movement, not sight, and leave one gap a door wide', () => {
  const [cells, portals] = MASKS.field;
  let runs = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals, { density: 1, shed: 0 }));
    const pipes = result.elements.filter(kind('pipe'));
    assert.equal(result.manifest.pipes, pipes.length);
    assert.equal(result.manifest.machines, result.elements.filter(kind('machine')).length);
    for (const pipe of pipes) {
      runs++;
      // Two stubs at most, each a piece or, where a chamfer cuts its end, two.
      assert.ok(pipe.template.parts.length >= 1 && pipe.template.parts.length <= 4);
      for (const stub of pipe.template.parts) assert.equal(stub.kind, 'pipe');
      const { free } = gapOf(pipe);
      assert.equal(free.length, 1, `${pipe.label} has one gap`);
      assert.equal(free[0][1] - free[0][0], 2, `${pipe.label}'s gap is 2 cells`);
    }
  }
  assert.ok(runs > 10, `${runs} runs`);
});

test('the shed is a roofed design, traced, and a way through', () => {
  const [cells, portals] = MASKS.field;
  let seen = 0;
  for (const seed of SEEDS) {
    const traces = new Map();
    const result = buildRegion(brief('field', seed, cells, portals, { shed: 1 }), undefined, trace => traces.set(trace.label, trace));
    const sheds = result.elements.filter(kind('shed'));
    assert.equal(result.manifest.sheds, sheds.length);
    assert.equal(result.manifest.structures, sheds.length);
    for (const shed of sheds) {
      seen++;
      assert.equal(shed.template.encloses, true);
      const trace = traces.get(shed.label);
      assert.deepEqual(trace.origin, { x: shed.x, y: shed.y });
      const exits = trace.realization.openings.filter(o => o.kind === 'door' && (o.a === 'outside' || o.b === 'outside'));
      assert.ok(exits.length >= 2);
    }
    assert.equal(traces.size, sheds.length);
    const none = buildRegion(brief('field', seed, cells, portals, { shed: 0 }));
    assert.equal(none.elements.filter(kind('shed')).length, 0);
  }
  assert.ok(seen >= SEEDS.length - 1, `${seen} sheds`);
});

test('plants roll loot by zone and keep every site clear of machines, pipes and the shed', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals, { density: 1, shed: 1 });
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

test('a plant checks its parameters, and a region with no contained 10 × 10 goes to open', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { density: 2 })), /density/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { shed: -1 })), /shed/);
  const empty = buildRegion(brief('field', 1, cells, portals, { density: 0, shed: 0 }));
  assert.equal(empty.elements.length, 0);
  const thin = buildRegion(brief('thin', 1, cellsOf(40, 9), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(thin.manifest.machines, undefined);
  assert.equal(thin.elements.length, 0);
});

test('a macro-sized plant with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals));
  assertWithinBudget(performance.now() - started, 3000, 'macro plant built');
  assert.ok(result.manifest.machines > 100 && result.manifest.pipes > 50);
});

test('plant can place geometry against a hinted edge while protecting portals', () => {
  const cells = cellsOf(40, 30);
  const portals = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 10, length: 3 }];
  const hints = [{ axis: 'h', x: 0, y: 0, length: 40 }];
  const input = { ...brief('hinted', 1, cells, portals, { density: 1, shed: 1 }), hints };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.y === 0), 'a piece reaches the hinted north edge');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('large concave plant with many portals keeps a safe hinted attachment', () => {
  const cells = cellsOf(80, 30, (x, y) => y < 15 || x < 45);
  const portals = Array.from({ length: 33 }, (_, i) => ({ id: `north-${i}`, axis: 'h', x: i * 2, y: 0, length: 2 }));
  portals.push({ id: 'south', axis: 'h', x: 8, y: 30, length: 2 });
  const input = { ...brief('many-concave', 4, cells, portals, { density: 1, shed: 1 }), hints: [{ axis: 'v', x: 0, y: 17, length: 12 }] };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.x === 0), 'a piece reaches the hinted west edge');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('thin rectangular plant keeps a hunter aisle between opposite sides', () => {
  const cells = cellsOf(10, 18);
  const portals = [{ id: 'north', axis: 'h', x: 1, y: 0, length: 2 },
    { id: 'south', axis: 'h', x: 1, y: 18, length: 2 }];
  const input = brief('thin', 7, cells, portals, { density: 1, shed: 1 });
  const result = buildRegion(input);
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
  for (const element of result.elements) {
    const x = element.x / SIZE, width = element.template.w / SIZE;
    assert.ok(x >= 2 || 10 - x - width >= 2, `${element.label} leaves an aisle on one side`);
  }
});
