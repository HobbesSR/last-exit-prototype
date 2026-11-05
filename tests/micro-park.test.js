import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { seeThrough } from '../shared/movement.ts';
import { cellsOf } from './helpers/cells.js';
import { SIZE, THOROUGH, brief, built, MASKS, SEEDS, DENSE, blockers, kind, boxOf, gapBetween, assertParkPromise, assertClumpSpacing,
  assertParkKinds, assertPiecesAtSizes } from './helpers/park-fixtures.js';

// The fast tier runs the first seed; tests/slow/micro-park-promise.test.js runs all eight.
test('a park region keeps the portal promise over seeds, masks and parameters', () => assertParkPromise(SEEDS.slice(0, 1)));

// Seeds 1 and 2 of the dense field, the builds the clump test reads; tests/slow/micro-park-promise.test.js all eight.
test('a park is its own type, with trees and hedge fronts and no buildings', () => assertParkKinds(SEEDS.slice(0, 2)));

// Order independence and determinism are the builder contract's (micro-builder-contract-cord), which
// shuffles every cell list of six chain briefs (#807).
test('a tree is round, and a hedge blocks bodies but not sight', () => {
  const result = built('field', 1, DENSE);
  for (const tree of result.elements.filter(kind('tree'))) assert.equal(tree.template.parts[0].shape.kind, 'circle');
  assert.equal(seeThrough('hedge'), true);
  assert.equal(seeThrough('tree'), false);
});

// The fast tier runs two seeds; tests/slow/micro-park-promise.test.js runs all eight.
test('clumps keep an aisle from each other and respect portal margins', () => assertClumpSpacing(SEEDS.slice(0, 2)));

test('a region too small for a tree gets no tree, and with fronts off stays clear', () => {
  assert.equal(buildRegion(brief('speck', 1, cellsOf(3, 1), [], DENSE)).elements.some(kind('tree')), false);
  assert.equal(buildRegion(brief('speck', 1, cellsOf(3, 1), [], { ...DENSE, hedgeFronts: 0 })).elements.length, 0);
});

test('a one-tile park the lattice misses gets single trees cell by cell, clear of its portal routes (#717)', () => {
  // Fronts off: with them, a front fills the canvas first and the fallback rightly stands aside.
  const [cells, portals] = MASKS.tile, NO_FRONTS = { hedgeFronts: 0 };
  let filled = 0;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('tile', seed, cells, portals, NO_FRONTS));
    assert.equal(result.manifest.clumps, 0, `seed ${seed}: the lattice places nothing here`);
    assert.equal(result.manifest.trees, result.elements.length);
    if (result.elements.length) filled++;
    assert.ok(result.elements.every(kind('tree')));
    for (const [i, a] of result.elements.map(boxOf).entries()) for (const b of result.elements.map(boxOf).slice(i + 1))
      assert.ok(gapBetween(a, b) >= 2, `seed ${seed}: single trees keep a doorway apart`);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }, { search: 'thorough' }).errors, []);
    const reversed = structuredClone(result.brief);
    reversed.cells.reverse(); reversed.zones[0].cells.reverse();
    assert.deepEqual(buildRegion(reversed).elements, result.elements);
  }
  assert.ok(filled >= SEEDS.length / 2, `${filled} of ${SEEDS.length} seeds`);
  assert.equal(buildRegion(brief('tile', 1, cells, portals, { density: 0, hedges: 0, hedgeFronts: 0 })).elements.length, 0, 'zero density stays clear');
});

test('parameters outside 0 to 1 are refused', () => {
  const [cells, portals] = MASKS.field;
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { density: 2 })), /density/);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { hedges: -1 })), /hedges/);
});

// The fast tier runs the first seed; tests/slow/micro-park-promise.test.js all eight.
test('pieces keep valid, in-footprint geometry at small and large cell sizes', () => assertPiecesAtSizes(SEEDS.slice(0, 1)));

test('park can place geometry against a hinted edge while protecting portals', () => {
  const cells = cellsOf(40, 30);
  const portals = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 10, length: 3 }];
  const hints = [{ axis: 'h', x: 0, y: 0, length: 40 }];
  const input = { ...brief('hinted', 1, cells, portals, { density: 1, hedges: 0 }), hints };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.y === 0), 'a piece reaches the hinted north edge');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }, THOROUGH).errors, []);
});

test('large concave park with many portals keeps a safe hinted attachment', () => {
  const cells = cellsOf(80, 30, (x, y) => y < 15 || x < 45);
  const portals = Array.from({ length: 33 }, (_, i) => ({ id: `north-${i}`, axis: 'h', x: i * 2, y: 0, length: 2 }));
  portals.push({ id: 'south', axis: 'h', x: 8, y: 30, length: 2 });
  const input = { ...brief('many-concave', 4, cells, portals, { density: 1, hedges: 0 }), hints: [{ axis: 'v', x: 0, y: 17, length: 12 }] };
  const result = buildRegion(input);
  assert.ok(result.elements.some(element => element.x === 0), 'a piece reaches the hinted west edge');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }, THOROUGH).errors, []);
});

test('thin rectangular park keeps a hunter aisle between opposite sides', () => {
  const cells = cellsOf(4, 18);
  const portals = [{ id: 'north', axis: 'h', x: 1, y: 0, length: 2 },
    { id: 'south', axis: 'h', x: 1, y: 18, length: 2 }];
  const input = brief('thin', 7, cells, portals, { density: 1, hedges: 1 });
  const result = buildRegion(input);
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }, THOROUGH).errors, []);
  for (const element of result.elements) {
    const x = element.x / SIZE, width = element.template.w / SIZE;
    assert.ok(x >= 2 || 4 - x - width >= 2, `${element.label} leaves an aisle on one side`);
  }
});
