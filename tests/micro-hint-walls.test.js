import test from 'node:test';
import assert from 'node:assert/strict';
import { commitHintWalls, wallHints } from '../map/micro/hint-walls.ts';
import { disjoint } from '../shared/shape-construction.ts';
import { createBuilderCanvas } from '../map/micro/canvas.ts';
import { hintsOfStrength } from '../map/micro/hints.ts';
import { areasOverlap, createAddressedArea } from '../map/micro/addressed.ts';
import { buildRegion, briefErrors } from '../map/micro/region-types.ts';
import { createFillMask, createRegionMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { bounds, circle, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const key = c => `${c.x},${c.y}`;
const MUTUAL = { inside: 'not-passable-hint', across: 'not-passable-hint' };
const ONE_SIDED = { inside: 'not-passable-hint', across: 'any' };

// An 8 × 6 region hinted along its north face, its west face and part of its south face.
const brief = (hints, portals = []) => ({ id: 'r', seed: 1, type: 'open', cellSize: SIZE, cells: cellsOf(8, 6),
  zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: cellsOf(8, 6) }], portals, hints });
const NORTH = { axis: 'h', x: 0, y: 0, length: 8, stated: MUTUAL };
const WEST = { axis: 'v', x: 0, y: 0, length: 6, stated: ONE_SIDED };
const SOUTH = { axis: 'h', x: 2, y: 6, length: 4, stated: MUTUAL };

test('walls stand in the cells beside each hint, against its line, and close a convex corner', () => {
  const walls = wallHints(brief([NORTH, WEST, SOUTH]), { kind: 'building' });
  assert.deepEqual(walls.elements.map(e => e.label), ['hint-wall-h-0-0', 'hint-wall-v-0-0', 'hint-wall-h-2-5']);
  assert.deepEqual(walls.shapes.map(bounds), [
    { x: 0, y: 0, w: 8 * SIZE, h: 10 },
    { x: 0, y: 0, w: 10, h: 6 * SIZE },
    // The south face's wall stands against its line from the region's side.
    { x: 2 * SIZE, y: 6 * SIZE - 10, w: 4 * SIZE, h: 10 },
  ]);
  assert.equal(walls.elements.every(e => e.template.parts.every(p => p.kind === 'building')), true);
  // The corner cell is walled by both and listed once.
  assert.equal(walls.cells.filter(c => c.x === 0 && c.y === 0).length, 1);
  assert.equal(walls.cells.length, 8 + 5 + 4);
});

test('walls meeting at a corner commit as one assembly, the earlier keeping the corner as intent', () => {
  const b = brief([NORTH, WEST, SOUTH]), walls = wallHints(b, { kind: 'building' });
  const areas = disjoint(walls.shapes);
  assert.deepEqual(areas.map(bounds), [
    { x: 0, y: 0, w: 8 * SIZE, h: 10 },
    // The west wall's intent stops short of the north wall's.
    { x: 0, y: 10, w: 10, h: 6 * SIZE - 10 },
    { x: 2 * SIZE, y: 6 * SIZE - 10, w: 4 * SIZE, h: 10 },
  ]);
  assert.equal(areas.some((a, i) => areas.slice(0, i).some(o => areasOverlap(a, o))), false);
  const canvas = createBuilderCanvas(b);
  commitHintWalls(canvas, walls);
  assert.deepEqual(canvas.elements, walls.elements);
  // A wall wholly inside an earlier rectangle, or a polygon over one, adds no area of its own.
  assert.deepEqual(disjoint([rect(0, 0, 40, 10), rect(10, 0, 20, 10), circle(5, 5, 3)]).map(bounds), [{ x: 0, y: 0, w: 40, h: 10 }]);
});

test('thickness and inset set the wall across its cells', () => {
  const [shape] = wallHints(brief([SOUTH]), { kind: 'ruin-wall', thickness: 0.5, inset: 0.25 }).shapes;
  assert.deepEqual(bounds(shape), { x: 2 * SIZE, y: 5.25 * SIZE, w: 4 * SIZE, h: 0.5 * SIZE });
});

test('walls stay out of portal margins, so a portal beside a hint keeps its clear approach', () => {
  // A portal on the north face from column 2 to 3; the hints flank it.
  const portals = [{ id: 'p', axis: 'h', x: 2, y: 0, length: 2 }];
  const hints = [{ axis: 'h', x: 0, y: 0, length: 2 }, { axis: 'h', x: 4, y: 0, length: 4 }];
  const b = brief(hints, portals);
  assert.deepEqual(briefErrors(b), []);
  const walls = wallHints(b, { kind: 'building' });
  // The margin takes one cell past each end of the portal: columns 1 and 4.
  assert.deepEqual(walls.cells.map(key), ['0,0', '5,0', '6,0', '7,0']);
  const fill = createFillMask(b);
  assert.equal(walls.shapes.every(s => fill.contains(s)), true);
});

test('avoided shapes and addressed cells split a wall, short stretches are left bare, and walled cells are marked', () => {
  const b = brief([NORTH]);
  const addressed = createAddressedArea(createRegionMask(b));
  assert.ok(addressed.markCells([{ x: 2, y: 0 }]));
  // A route crossing column 5's wall; one in the middle of the cell, clear of the wall, avoids nothing.
  const avoid = [circle(5.5 * SIZE, 0.5 * SIZE, 0.3 * SIZE), circle(0.5 * SIZE, 3 * SIZE, SIZE)];
  const walls = wallHints(b, { kind: 'building', avoid, addressed, minLength: 2 });
  // Stretches: 0–1, (2 addressed), 3–4, (5 avoided), 6–7.
  assert.deepEqual(walls.elements.map(e => e.label), ['hint-wall-h-0-0', 'hint-wall-h-3-0', 'hint-wall-h-6-0']);
  assert.equal(walls.shapes.some(w => avoid.some(o => shapesOverlap(w, o))), false);
  for (const c of walls.cells) assert.ok(addressed.addressed(c.x, c.y));
  assert.equal(addressed.addressed(5, 0), false);
  // With a minimum of three, every stretch is too short.
  assert.deepEqual(wallHints(b, { kind: 'building', avoid: [rect(2 * SIZE, 0, SIZE, SIZE), rect(5 * SIZE, 0, SIZE, SIZE)], minLength: 3 }).elements, []);
});

test('a builder walls only mutual hints by passing them, and a brief without hints gets no walls', () => {
  const walls = wallHints(hintsOfStrength(brief([NORTH, WEST, SOUTH]), 'mutual'), { kind: 'building' });
  assert.deepEqual(walls.elements.map(e => e.label), ['hint-wall-h-0-0', 'hint-wall-h-2-5']);
  assert.deepEqual(wallHints(brief(undefined), { kind: 'building' }), { elements: [], shapes: [], cells: [] });
  assert.throws(() => wallHints(brief([NORTH]), { kind: 'building', minLength: 0 }), RangeError);
});

// A 24 × 18 field with portals west, east and north, hinted along the rest of its north, west and south faces.
const FIELD = {
  cells: cellsOf(24, 18),
  portals: [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }],
  hints: [{ axis: 'h', x: 0, y: 0, length: 18, stated: MUTUAL }, { axis: 'v', x: 0, y: 0, length: 7, stated: ONE_SIDED },
    { axis: 'v', x: 0, y: 10, length: 8, stated: ONE_SIDED }, { axis: 'h', x: 0, y: 18, length: 24, stated: MUTUAL }],
};

test('hall, ruins and rubble wall their hints around their own pieces and keep the portal promise', () => {
  for (const type of ['hall', 'ruins', 'rubble']) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const b = { id: `${type}-${seed}`, seed, type, cellSize: SIZE, cells: FIELD.cells, portals: FIELD.portals, hints: FIELD.hints,
      zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells: FIELD.cells }] };
    const result = buildRegion(b), name = `${type} seed ${seed}`;
    const walls = result.elements.filter(e => e.label.startsWith('hint-wall-')), others = result.elements.filter(e => !walls.includes(e));
    assert.ok(result.manifest.hintWalls > 0, `${name} stood hint walls`);
    assert.equal(walls.flatMap(e => elementShapes(e)).length, result.manifest.hintWalls, name);
    const wallShapes = walls.flatMap(e => elementShapes(e)), pieces = others.flatMap(e => elementShapes(e));
    assert.equal(wallShapes.some(w => pieces.some(p => shapesOverlap(w, p))), false, `${name} walls clear of its pieces`);
    assert.equal(wallShapes.some(w => result.loot.some(l => shapesOverlap(w, circle(l.x, l.y, 1)))), false, `${name} loot clear of walls`);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: [...pieces, ...wallShapes] }).errors, [], name);
    // Without hints, nothing is walled.
    const bare = buildRegion({ ...b, hints: undefined });
    assert.equal(bare.manifest.hintWalls, 0, name);
    assert.equal(bare.elements.some(e => e.label.startsWith('hint-wall-')), false, name);
  }
});
