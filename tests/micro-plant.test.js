import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'plant', cellSize: SIZE, cells,
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
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
const kind = prefix => element => element.label.startsWith(`plant-${prefix}`);
const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

test('a plant region keeps the portal promise over seeds, masks and parameters', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [undefined, { density: 1, shed: 0 }, { density: 1, shed: 1 }, { density: 0.3 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      if (name !== 'yard' && parameters?.density === 1) assert.ok(result.elements.length > 0, `${name} seed ${seed} stood machines or a shed`);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
});

test('plants are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('machines and the shed keep an aisle from each other and the edge, and pipes from all but what they join', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [{ density: 1, shed: 0 }, { density: 1, shed: 1 }]) {
      const input = brief(name, seed, cells, portals, parameters);
      const result = buildRegion(input), mask = createRegionMask(input);
      const solid = result.elements.filter(e => !kind('pipe')(e)).map(e => ({ label: e.label, box: cellBox(e) }));
      for (const [i, { label, box }] of solid.entries()) {
        for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++)
          assert.ok(mask.has(x, y), `${name} ${seed}: ${label} keeps 2 owned cells around it`);
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

/** A run's stubs as intervals along it, in cells from the run's start, and the gap they leave. */
function gapOf(pipe) {
  const across = pipe.template.w > pipe.template.h, length = (across ? pipe.template.w : pipe.template.h) / SIZE - 1;
  const stubs = pipe.template.parts.map(({ shape }) => across ? [shape.x / SIZE - 0.5, (shape.x + shape.w) / SIZE - 0.5]
    : [shape.y / SIZE - 0.5, (shape.y + shape.h) / SIZE - 0.5]).sort((a, b) => a[0] - b[0]);
  const free = [];
  let at = 0;
  for (const [start, end] of stubs) { if (start > at) free.push([at, start]); at = Math.max(at, end); }
  if (at < length) free.push([at, length]);
  return { across, free };
}

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
      assert.ok(pipe.template.parts.length >= 1 && pipe.template.parts.length <= 2);
      for (const stub of pipe.template.parts) assert.equal(stub.kind, 'pipe');
      const { free } = gapOf(pipe);
      assert.equal(free.length, 1, `${pipe.label} has one gap`);
      assert.equal(free[0][1] - free[0][0], 2, `${pipe.label}'s gap is 2 cells`);
    }
  }
  assert.ok(runs > 10, `${runs} runs`);
});

test('a hunter passes every pipe gap, and a contestant reaches every loot site, indoors and out', () => {
  const { hunter, contestant } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance;
  let gaps = 0;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 4)) {
    const input = brief(name, seed, cells, portals, { density: 1, shed: 1 });
    input.zones[0].lootChance = 1;
    const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
    const from = portalStands(input, mask)[0].points[0];
    // A cell either side of each gap's middle, both reached by a hunter.
    for (const pipe of result.elements.filter(kind('pipe'))) {
      const { across, free: [[start, end]] } = gapOf(pipe), middle = (start + end) / 2 + 0.5;
      const centre = across ? { x: pipe.x + middle * SIZE, y: pipe.y + SIZE / 2 } : { x: pipe.x + SIZE / 2, y: pipe.y + middle * SIZE };
      for (const side of [-1, 1]) {
        gaps++;
        const point = across ? { x: centre.x, y: centre.y + side * SIZE } : { x: centre.x + side * SIZE, y: centre.y };
        assert.ok(findRegionRoute(mask, shapes, from, point, hunter), `${name} ${seed}: ${pipe.label} side ${side}`);
      }
    }
    const every = Math.ceil(result.loot.length / 30);
    const shed = result.elements.find(kind('shed'));
    const inside = site => shed && site.x > shed.x && site.x < shed.x + shed.template.w && site.y > shed.y && site.y < shed.y + shed.template.h;
    for (const site of result.loot.filter((site, i) => inside(site) || i % every === 0))
      assert.ok(findRegionRoute(mask, shapes, from, site, contestant), `${name} ${seed}: ${site.x},${site.y} is reachable`);
  }
  assert.ok(gaps > 20, `${gaps} gap sides`);
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
  assert.ok(performance.now() - started < 3000, `built in ${Math.round(performance.now() - started)} ms`);
  assert.ok(result.manifest.machines > 100 && result.manifest.pipes > 50);
});
