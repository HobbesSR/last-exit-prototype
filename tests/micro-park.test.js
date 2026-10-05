import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { seeThrough } from '../shared/movement.ts';
import { bounds } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'park', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A tile, a wide field, an L, and a ring around a hole, with portals on several sides. */
const MASKS = {
  tile: [cellsOf(6, 6), [{ id: 'west', axis: 'v', x: 0, y: 2, length: 2 }, { id: 'east', axis: 'v', x: 6, y: 1, length: 3 }]],
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const DENSE = { density: 1, hedges: 0.5 };
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const kind = prefix => element => element.label.startsWith(`park-${prefix}`);
const boxOf = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

test('a park region keeps the portal promise over seeds, masks and parameters', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS)
    for (const parameters of [undefined, DENSE, { density: 0, hedges: 1 }, { density: 0.3, hedges: 0 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
});

test('a park is its own type, with trees and hedges and no buildings', () => {
  const [cells, portals] = MASKS.field;
  let trees = 0, hedges = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals, DENSE));
    for (const element of result.elements) for (const part of element.template.parts) {
      assert.equal(part.part, 'obstacle');
      assert.equal(part.kind, element.label.startsWith('park-tree') ? 'tree' : 'hedge');
    }
    trees += result.elements.filter(kind('tree')).length;
    hedges += result.elements.filter(kind('hedge')).length;
    assert.equal(result.manifest.trees, result.elements.filter(kind('tree')).length);
    assert.equal(result.manifest.hedges, result.elements.filter(kind('hedge')).length);
    assert.equal(result.manifest.structures, 0);
  }
  assert.ok(trees > 40 && hedges > 5, `${trees} trees, ${hedges} hedges`);
});

test('parks are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
});

test('a tree is round, and a hedge blocks bodies but not sight', () => {
  const [cells, portals] = MASKS.field;
  const result = buildRegion(brief('field', 1, cells, portals, DENSE));
  for (const tree of result.elements.filter(kind('tree'))) assert.equal(tree.template.parts[0].shape.kind, 'circle');
  assert.equal(seeThrough('hedge'), true);
  assert.equal(seeThrough('tree'), false);
});

test('clumps and hedge runs keep an aisle from each other and the edge, and each run has one door-wide gap', () => {
  let runs = 0;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const input = brief(name, seed, cells, portals, DENSE);
    const result = buildRegion(input), mask = createRegionMask(input);
    // A clump is its trees together, boxed; a hedge run is its element's box.
    const hedgeBoxes = result.elements.filter(kind('hedge')).map(e => ({ label: e.label, box: boxOf(e) }));
    const trees = result.elements.filter(kind('tree')).map(boxOf);
    for (const tree of trees) {
      for (let y = tree.y - 2; y < tree.y + tree.h + 2; y++) for (let x = tree.x - 2; x < tree.x + tree.w + 2; x++)
        assert.ok(mask.has(x, y), `${name} ${seed}: a tree keeps 2 owned cells around it`);
      for (const { label, box } of hedgeBoxes) assert.ok(gapBetween(tree, box) >= 2, `${name} ${seed}: a tree and ${label}`);
    }
    for (const [i, { label, box }] of hedgeBoxes.entries()) {
      runs++;
      for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++)
        assert.ok(mask.has(x, y), `${name} ${seed}: ${label} keeps 2 owned cells around it`);
      for (const other of hedgeBoxes.slice(i + 1)) assert.ok(gapBetween(box, other.box) >= 2, `${label} and ${other.label}`);
      const element = result.elements.find(e => e.label === label), across = box.w > box.h;
      const stubs = element.template.parts.map(({ shape }) => bounds(shape)).map(b => across ? [b.x / SIZE, (b.x + b.w) / SIZE] : [b.y / SIZE, (b.y + b.h) / SIZE])
        .sort((a, b) => a[0] - b[0]);
      assert.equal(stubs.length, 2, `${label} has a stub each side of its gap`);
      assert.equal(stubs[1][0] - stubs[0][1], 2, `${label}'s gap is 2 cells`);
      assert.ok(stubs[0][1] - stubs[0][0] >= 1 && stubs[1][1] - stubs[1][0] >= 1);
    }
    // Trees in different clumps keep their aisle: any two closer than it are in one clump (a slot's band).
    for (const [i, a] of trees.entries()) for (const b of trees.slice(i + 1))
      if (gapBetween(a, b) < 2) assert.ok(Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4, `${name} ${seed}: trees ${a.x},${a.y} and ${b.x},${b.y}`);
  }
  assert.ok(runs > 10, `${runs} runs`);
});

test('a region too small for a piece stays clear', () => {
  const result = buildRegion(brief('speck', 1, cellsOf(3, 3), [], DENSE));
  assert.equal(result.elements.length, 0);
});

test('parameters outside 0 to 1 are refused', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { density: 2 })), /density/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { hedges: -1 })), /hedges/);
});

test('pieces keep valid, in-footprint geometry at small and large cell sizes', () => {
  for (const size of [1, 2, 8, 40, 200]) for (const seed of SEEDS) {
    const cells = cellsOf(30, 30), input = { ...brief('field', seed, cells, [], { density: 1, hedges: 0.5 }), cellSize: size };
    input.zones = [{ tier: 3, bonus: 0, lootChance: 0, cells }];
    const result = buildRegion(input);
    assert.ok(result.elements.some(kind('hedge')) && result.elements.some(kind('tree')), `size ${size} seed ${seed} has both`);
    for (const element of result.elements) for (const { shape } of element.template.parts) {
      const box = bounds(shape);
      assert.ok(box.w > 0 && box.h > 0, `size ${size}: ${element.label} has area`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= element.template.w + 1e-9 && box.y + box.h <= element.template.h + 1e-9, `size ${size}: ${element.label} stays in its footprint`);
    }
  }
});
