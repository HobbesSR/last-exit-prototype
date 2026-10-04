import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'ruins', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides. */
const MASKS = {
  yard: [cellsOf(10, 8), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 10, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 4, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 5, length: 2 }]],
  field: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(18, 18, (x, y) => y < 9 || x < 9), [{ id: 'east', axis: 'v', x: 18, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 18, length: 3 },
    { id: 'corner', axis: 'h', x: 10, y: 9, length: 4 }]],
  ring: [cellsOf(20, 20, (x, y) => x < 6 || x >= 14 || y < 6 || y >= 14), [{ id: 'north', axis: 'h', x: 8, y: 0, length: 2 },
    { id: 'hole', axis: 'v', x: 14, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 15, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('a ruins region keeps the portal promise over seeds, masks and parameters', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [undefined, { density: 1, decay: 0 }, { density: 1, decay: 1 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
});

test('ruins are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.ok(result.manifest.rooms > 0, `seed ${seed} stood a room`);
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('density sets how many rooms stand, and decay turns walls to debris', () => {
  const [cells, portals] = MASKS.field;
  const none = buildRegion(brief('field', 5, cells, portals, { density: 0 }));
  assert.equal(none.elements.length, 0);
  const whole = buildRegion(brief('field', 5, cells, portals, { density: 1, decay: 0 }));
  const fallen = buildRegion(brief('field', 5, cells, portals, { density: 1, decay: 1 }));
  assert.equal(whole.manifest.debris, 0);
  assert.ok(whole.manifest.walls > 0);
  assert.equal(fallen.manifest.walls, 0);
  assert.ok(fallen.manifest.debris > 0);
  assert.ok(whole.manifest.rooms >= buildRegion(brief('field', 5, cells, portals, { density: 0.3 })).manifest.rooms);
  for (const shape of blockers(fallen)) assert.equal(shape.kind, 'polygon');
  assert.throws(() => buildRegion(brief('field', 5, cells, portals, { decay: 2 })), /decay/);
});

test('every room keeps a doorway, so nothing is sealed off from a contestant', () => {
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 3)) {
    // No decay: every wall but the doorways stands, the hardest case for getting in.
    // Loot on every cell marks the free ground, rooms' insides included.
    const input = brief(name, seed, cells, portals, { density: 1, decay: 0 });
    input.zones[0].lootChance = 1;
    const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
    const from = portalStands(input, mask)[0].points[0];
    for (const site of result.loot.filter((_, i) => i % 7 === 0))
      assert.ok(findRegionRoute(mask, shapes, from, site, radius), `${name} ${seed}: ${site.x},${site.y} is reachable`);
  }
});

test('ruins roll loot by zone and keep every site clear of geometry', () => {
  const [cells, portals] = MASKS.field;
  const input = brief('field', 11, cells, portals, { density: 1, decay: 0.5 });
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 9) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 9) }];
  const result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 9 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
  assert.equal(result.manifest.loot, result.loot.length);
});

test('a ruins region too small for a room goes to open', () => {
  const thin = cellsOf(20, 2);
  const result = buildRegion(brief('thin', 1, thin, [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(result.manifest.rooms, undefined);
  const small = cellsOf(4, 5);
  assert.equal(buildRegion(brief('small', 1, small, [])).manifest.rooms, undefined);
});
