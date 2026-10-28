import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createFillMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { rect } from '../shared/shape.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import { cellsOf } from './helpers/cells.js';
import { chainBrief, reorderedBrief, SIZE } from './helpers/chain-briefs.js';

const field = (w, h, options = {}) => chainBrief({ type: 'market', cells: cellsOf(w, h), ...options });
const boxes = result => result.elements.map(e => ({ x: e.x / SIZE, y: e.y / SIZE, w: e.template.w / SIZE, h: e.template.h / SIZE }));
const blockers = result => result.elements.flatMap(e => elementShapes(e));

function checkGeometry(input, result) {
  const fill = createFillMask(input), access = createAccessMask(input), routes = protectedRoutes(input, 'Market');
  const pieces = boxes(result);
  assert.ok(pieces.length > 0);
  assert.equal(result.manifest.stalls, pieces.length);
  for (const [i, b] of pieces.entries()) {
    const footprint = rect(b.x * SIZE, b.y * SIZE, b.w * SIZE, b.h * SIZE);
    assert.ok(fill.contains(footprint), 'stall is in reduced fill');
    assert.ok(access.contains(rect((b.x - 2) * SIZE, (b.y - 2) * SIZE, (b.w + 4) * SIZE, (b.h + 4) * SIZE)), 'complete hunter bypass ring');
    assert.ok(routes.every(route => !shapesOverlap(footprint, route)), 'stall leaves protected routes clear');
    for (const other of pieces.slice(i + 1)) {
      const gap = Math.max(other.x - b.x - b.w, b.x - other.x - other.w, other.y - b.y - b.h, b.y - other.y - other.h);
      assert.ok(gap >= 2, `two-cell aisle, got ${gap}`);
    }
  }
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
}

test('market stalls fit their fill and access masks, keep routes and portals clear, and run along the longer axis', () => {
  for (const [w, h] of [[36, 24], [24, 36]]) {
    const input = field(w, h, { portals: [{ id: 'west', axis: 'v', x: 0, y: 3, length: 3 },
      { id: 'east', axis: 'v', x: w, y: h - 6, length: 3 }],
      internal: [{ axis: 'h', x: 0, y: Math.floor(h / 2), length: w }] });
    const result = buildRegion(input);
    checkGeometry(input, result);
    for (const box of boxes(result)) assert.deepEqual([box.w, box.h], w > h ? [4, 2] : [2, 4]);
    assert.equal(result.manifest.awnings, result.manifest.stalls);
    assert.equal(result.manifest.structures, 0);
  }
});

test('market spacing controls length, preserves aisles, and an unroofed market has no awnings', () => {
  for (const spacing of [4, 5, 6]) {
    const input = field(36, 24, { parameters: { spacing, roofed: false } });
    const result = buildRegion(input);
    checkGeometry(input, result);
    assert.equal(result.manifest.awnings, 0);
    for (const box of boxes(result)) assert.deepEqual([box.w, box.h], [Math.min(4, spacing - 2), 2]);
  }
  const input = field(36, 24);
  const implicit = buildRegion(input), explicit = buildRegion({ ...input, parameters: { spacing: 6, roofed: true } });
  assert.deepEqual([implicit.elements, implicit.loot, implicit.manifest], [explicit.elements, explicit.loot, explicit.manifest]);
});

test('market checks parameters and leaves a no-fit region unfilled', () => {
  for (const parameters of [{ spacing: 3 }, { spacing: 4.5 }, { spacing: '6' }, { roofed: 'yes' }])
    assert.throws(() => buildRegion(field(20, 20, { parameters })));
  const result = buildRegion(field(30, 5));
  assert.equal(result.elements.length, 0);
  assert.equal(result.manifest.stalls, undefined);
});

test('market awnings stamp as independent roofs without changing collision or obstacle IDs', () => {
  const stamp = roofed => {
    const result = buildRegion(field(24, 18, { parameters: { roofed } }));
    const context = createGenerationContext(1);
    for (const element of result.elements)
      placeElement(context, element.template, element.x, element.y, { nodeId: 'market' });
    return { result, map: context.map };
  };
  const covered = stamp(true), uncovered = stamp(false);
  assert.deepEqual(covered.map.obstacles, uncovered.map.obstacles);
  assert.equal(covered.map.buildings.length, 0);
  assert.equal(covered.map.roofs.length, covered.result.manifest.awnings);
  assert.equal(new Set(covered.map.roofs.map(roof => roof.id)).size, covered.map.roofs.length);
  assert.ok(covered.map.roofs.every(roof => roof.cells.length === 8 && !roof.buildingId));
  assert.equal(uncovered.map.roofs?.length ?? 0, 0);
});

test('market fills both wings of an L and ignores cell ordering', () => {
  const cells = cellsOf(36, 36, (x, y) => y < 14 || x < 14);
  const input = chainBrief({ type: 'market', cells });
  const result = buildRegion(input);
  checkGeometry(input, result);
  assert.ok(boxes(result).some(b => b.x >= 14), 'horizontal wing');
  assert.ok(boxes(result).some(b => b.y >= 14), 'vertical wing');
  assert.deepEqual(buildRegion(reorderedBrief(input, 42)).elements, result.elements);
});


test('market rows alternate counter edges and share seeded cross-lanes', () => {
  const result = buildRegion(field(38, 22, { seed: 3 }));
  const rows = new Map();
  for (const element of result.elements) {
    const row = element.y / SIZE, counter = element.template.parts.find(p => p.part === 'obstacle').shape;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ x: element.x / SIZE, counterY: counter.y / SIZE });
  }
  const entries = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  assert.ok(entries.length >= 3);
  const columns = entries[0][1].map(p => p.x);
  assert.ok(columns.some((x, i) => i && x - columns[i - 1] === 12), 'one skipped slot creates a cross-lane');
  for (const [i, [y, row]] of entries.entries()) {
    assert.deepEqual(row.map(p => p.x), columns, 'cross-lane aligns across rows');
    if (i) {
      assert.equal(y - entries[i - 1][0], 4);
      assert.notEqual(row[0].counterY, entries[i - 1][1][0].counterY);
    }
  }
  const short = buildRegion(field(20, 10));
  assert.equal(new Set(boxes(short).map(b => b.x)).size, 3, 'three potential columns have no cross-lane skip');
});
