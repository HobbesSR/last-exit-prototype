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
    for (const [i, box] of boxes.entries()) {
      for (let y = box.y - 3; y < box.y + box.h + 3; y++) for (let x = box.x - 3; x < box.x + box.w + 3; x++)
        assert.ok(mask.has(x, y), `${name} ${seed}: ${result.elements[i].label} keeps 3 owned cells around it`);
      for (const other of boxes.slice(i + 1)) {
        const gap = Math.max(other.x - (box.x + box.w), box.x - (other.x + other.w), other.y - (box.y + box.h), box.y - (other.y + other.h));
        assert.ok(gap >= 3, `${name} ${seed}: aisle ${gap}`);
      }
    }
    // Rows and warehouses share one long axis.
    const long = new Set(boxes.map(box => box.w > box.h ? 'x' : 'y'));
    assert.equal(long.size, 1, `${name} ${seed}: one axis`);
  }
});

test('warehouses are roofed, with a door at each end and shelves inside', () => {
  const [cells, portals] = MASKS.field;
  let seen = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals, { density: 1, roomCells: 12 }));
    assert.equal(result.manifest.structures, result.manifest.warehouses);
    for (const element of result.elements.filter(e => e.label.startsWith('depot-warehouse'))) {
      seen++;
      const { w, h } = cellBox(element);
      assert.deepEqual([Math.max(w, h), Math.min(w, h)], [12, 9]);
      assert.equal(element.template.encloses, true);
      const gates = element.template.parts.filter(p => p.part === 'gate');
      assert.equal(gates.length, 2);
      for (const gate of gates) assert.equal(Math.max(gate.w, gate.h), 2 * SIZE);
      assert.equal(element.template.parts.filter(p => p.kind === 'container').length, 2);
    }
  }
  assert.ok(seen > 0);
});

test('every aisle is open to a contestant, indoors and out', () => {
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 3))
    for (const roomCells of [6, 9]) {
      const input = brief(name, seed, cells, portals, { density: 1, roomCells });
      input.zones[0].lootChance = 1;
      const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
      const from = portalStands(input, mask)[0].points[0];
      // Every site in the first warehouse, which tests its doors and shelf aisles, and a sample outdoors.
      const first = result.elements.find(element => element.label.startsWith('depot-warehouse'));
      const indoors = first ? result.loot.filter(site => site.x > first.x && site.x < first.x + first.template.w
        && site.y > first.y && site.y < first.y + first.template.h) : [];
      if (first) assert.ok(indoors.length > 0, `${name} ${seed}: loot indoors`);
      const every = Math.ceil(result.loot.length / 8);
      for (const site of [...indoors, ...result.loot.filter((_, i) => i % every === 0)])
        assert.ok(findRegionRoute(mask, shapes, from, site, radius), `${name} ${seed}: ${site.x},${site.y} is reachable`);
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
  assert.ok(performance.now() - started < 3000, `built in ${Math.round(performance.now() - started)} ms`);
  assert.ok(result.manifest.warehouses > 10 && result.manifest.rows > 100);
  assert.ok(bounds(blockers(result)[0]).w > 0);
});
