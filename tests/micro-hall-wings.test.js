import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { bounds, circle } from '../shared/shape.ts';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { cellsOf } from './helpers/cells.js';

const S = 40;
const make = (cells, extra = {}) => ({ id: 'wings', seed: 7, type: 'hall', cellSize: S, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals: [], ...extra });
const wing = r => r.elements.filter(e => e.label.startsWith('hall-wing-'));
const hall = r => r.elements.filter(e => e.label === 'hall' || e.label.startsWith('hall-wing-'));
const extent = e => [e.x / S, e.y / S, e.template.w / S, e.template.h / S];
const gap = (a, b) => Math.max(b.x-a.x-a.w, a.x-b.x-b.w, b.y-a.y-a.h, a.y-b.y-b.h);
const fixtures = [
  ['L', cellsOf(30, 30, (x,y) => y < 14 || x < 14), [[0,0,30,14], [0,14,14,16]]],
  ['T', cellsOf(30, 30, (x,y) => y < 12 || (x >= 9 && x < 21)), [[0,0,30,12], [9,12,12,18]]],
  ['ring', cellsOf(30, 30, (x,y) => x < 8 || x >= 22 || y < 8 || y >= 22), [[0,0,30,8], [0,8,8,14], [0,22,30,8], [22,8,8,14]]],
  ['step', cellsOf(30, 30, (x,y) => y < 10 || (y < 20 && x < 20) || x < 10), [[0,0,20,20], [20,0,10,10], [0,20,10,10]]],
];

test('L, T, ring and stepped halls fill connected bays with spaced, perimeter-inset pillars', () => {
  for (const [name, cells, expected] of fixtures) for (const roofed of [false, true]) {
    const result = buildRegion(make(cells, { parameters: { roofed } }));
    assert.deepEqual(hall(result).map(extent), expected, name);
    assert.equal(wing(result).length, expected.length - 1, name);
    assert.ok(hall(result).every(e => e.template.encloses === (roofed || undefined)));
    const pillars = hall(result).flatMap(e => elementShapes(e).map(bounds));
    for (const e of wing(result)) {
      assert.ok(e.template.parts.length > 0, name);
      for (const p of elementShapes(e).map(bounds)) {
        assert.ok(p.x >= e.x + 2.5*S && p.y >= e.y + 2.5*S && p.x+p.w <= e.x+e.template.w-2.5*S && p.y+p.h <= e.y+e.template.h-2.5*S, name);
      }
    }
    for (let i = 0; i < pillars.length; i++) for (let j = 0; j < i; j++) assert.ok(gap(pillars[i], pillars[j]) >= 2*S - 1e-7, name);
    assert.ok(hall(result).every(e => e.template.parts.every(p => p.kind === 'building' && p.shape.kind === 'rect' && p.shape.w === 1.5*S && p.shape.h === 1.5*S)), name);
  }
});

test('selected bays stay reserved at huge spacing', () => {
  const cells = fixtures[0][1];
  const result = buildRegion(make(cells, { parameters: { spacing: 100 } }));
  assert.equal(result.manifest.infillCrates, 0);
  const roofed = buildRegion(make(cells, { parameters: { spacing: 100, roofed: true } }));
  assert.deepEqual(hall(roofed).map(extent), fixtures[0][2]);
  assert.ok(hall(roofed).every(e => e.template.encloses));
  // The single secondary pillar is protected away by a route across its bay.
  // Its otherwise empty rectangle must still be excluded from crate infill.
  const empty = buildRegion(make(cells, { parameters: { spacing: 100 }, portals: [
    { id: 'west', axis: 'v', x: 0, y: 21, length: 2 },
    { id: 'indent', axis: 'v', x: 14, y: 21, length: 2 },
  ] }));
  assert.equal(wing(empty).length, 0);
  assert.equal(empty.manifest.infillCrates, 0);
});

test('a six-cell wing keeps its perimeter walk even when no pillar fits inside it', () => {
  const cells = cellsOf(20, 20, (x,y) => y < 10 || x < 6);
  const open = buildRegion(make(cells));
  assert.equal(wing(open).length, 0);
  assert.equal(open.manifest.infillCrates, 0);
  const roofed = buildRegion(make(cells, { parameters: { roofed: true } }));
  assert.equal(wing(roofed).length, 1);
  assert.deepEqual(wing(roofed)[0].template.parts, []);
});

test('detached, thin and one-cell joins remain residual', () => {
  for (const [name, cells] of [
    ['detached', cellsOf(30, 16, (x,y) => x < 14 || x >= 20 || (y === 7 && x >= 14 && x < 20))],
    ['thin', cellsOf(30, 30, (x,y) => y < 14 || x < 5)],
    ['one-cell join', cellsOf(30, 30, (x,y) => y < 14 || (x >= 13 && x < 20 && y >= 14 && (y > 14 || x === 13)))],
  ]) {
    const result = buildRegion(make(cells));
    assert.equal(wing(result).length, 0, name);
  }
  assert.equal(buildRegion(make(cellsOf(20, 5))).manifest.pillars, undefined);
});

test('wings are deterministic under reordered cells and portals, and translate and scale', () => {
  const cells = fixtures[0][1], portals = [{ id: 'east', axis: 'v', x: 30, y: 4, length: 2 }, { id: 'south', axis: 'h', x: 4, y: 30, length: 2 }];
  const input = make(cells, { portals }), result = buildRegion(input);
  assert.deepEqual(buildRegion({ ...input, cells: [...cells].reverse() }).elements, result.elements);
  assert.deepEqual(buildRegion({ ...input, portals: [...portals].reverse() }).elements, result.elements);
  const offset = cells.map(({x,y}) => ({x:x+100,y:y-70}));
  const a = buildRegion(make(cells, { parameters: { roofed: true } }));
  const b = buildRegion(make(offset, { cellSize: 2.5, parameters: { roofed: true } }));
  assert.deepEqual(hall(b).map(e => [e.x/2.5-100,e.y/2.5+70,e.template.w/2.5,e.template.h/2.5]), hall(a).map(extent));
});

test('hunter reaches a wing perimeter through the join and loot clears final geometry', () => {
  const cells = fixtures[0][1], portals = [{ id: 'east', axis: 'v', x: 30, y: 5, length: 2 }];
  const input = make(cells, { portals }), result = buildRegion(input);
  const shapes = result.elements.flatMap(e => elementShapes(e, true));
  const from = portalStands(input)[0].points[0], access = createAccessMask(input);
  for (const end of [{x: 1.5*S,y: 18.5*S}, {x: 1.5*S,y: 22.5*S}])
    assert.ok(findRegionRoute(access, shapes, from, end, hunterClearance(S)));
  const radius = microMetrics({ cellSize: S, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  for (const site of result.loot) assert.ok(shapes.every(shape => !shapesOverlap(circle(site.x, site.y, radius), shape)));
});


test('a hinted authored wing retains the hunter lane beside its perimeter wall', () => {
  // A two-cell bay inset left a physically open lane missed by the half-cell
  // route grid. The 2.5-cell inset keeps this actual authored stand reachable.
  const input = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/hall-wing-hinted.json.gz', import.meta.url))));
  const result = buildRegion(input), target = { x: 15936, y: 3516 };
  assert.equal(result.manifest.infillCrates, 0);
  const nearest = portalStands(input).flatMap(p => p.points).sort((a,b) =>
    Math.hypot(a.x-target.x,a.y-target.y)-Math.hypot(b.x-target.x,b.y-target.y))[0];
  assert.ok(findRegionRoute(createAccessMask(input), result.elements.flatMap(e => elementShapes(e)),
    nearest, target, hunterClearance(input.cellSize)));
});
