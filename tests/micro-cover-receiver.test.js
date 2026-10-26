import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCover, COVER_EXECUTION, previewedCoverExecution } from '../map/micro/strategies/cover.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { cellsOf } from './helpers/cells.js';

const input = (id, cells, fillCells, extra = {}) => ({ id, seed: 1, type: 'cover', cellSize: 40,
  cells, fillCells, portals: [], zones: [{ tier: 2, bonus: 0, lootChance: 1, cells }], ...extra });
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const footprint = element => ({ x: element.x / 40, y: element.y / 40,
  w: element.template.w / 40, h: element.template.h / 40 });

test('a missed inherited pocket receives whole cover pieces and keeps loot standing clear', () => {
  const cells = cellsOf(8, 8), fill = cells.filter(c => c.x >= 3 && c.x <= 5 && c.y >= 3 && c.y <= 5);
  const brief = input('pocket', cells, fill);
  const normal = buildCover(brief), received = COVER_EXECUTION.build(brief);
  assert.equal(normal.elements.length, 0);
  assert.ok(received.elements.length > 0);
  assert.equal(COVER_EXECUTION.receiving(brief), null);
  const allowed = new Set(fill.map(c => `${c.x},${c.y}`));
  for (const element of received.elements) {
    const { x, y, w, h } = footprint(element);
    assert.ok([[1, 1], [2, 1], [1, 2]].some(([width, height]) => w === width && h === height));
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) assert.ok(allowed.has(`${i},${j}`));
  }
  for (const loot of received.loot) for (const element of received.elements) {
    const { x, y, w, h } = footprint(element), lx = Math.floor(loot.x / 40), ly = Math.floor(loot.y / 40);
    assert.ok(x >= lx + 2 || x + w <= lx - 1 || y >= ly + 2 || y + h <= ly - 1,
      'loot retains its complete 3 by 3 standing area');
  }
  assert.deepEqual(validateFillConstraints(brief, blockers(received)), []);
  assert.deepEqual(COVER_EXECUTION.build(structuredClone(brief)), received);
  const preview = previewedCoverExecution();
  assert.equal(preview.receiving(brief), null);
  assert.deepEqual(preview.build(brief), received);
  assert.deepEqual(preview.build(structuredClone(brief)), received);
});

test('an irregular delegated remnant is usable while empty, margined and zero-density fills are rejected', () => {
  const cells = cellsOf(8, 8), fill = cells.filter(c => c.x >= 3 && c.x <= 5 && c.y >= 3 && c.y <= 5 || c.x === 6 && c.y === 5);
  const brief = input('irregular', cells, fill);
  assert.equal(buildCover(brief).elements.length, 0);
  assert.ok(COVER_EXECUTION.build(brief).elements.length);
  for (const rejected of [input('empty', cells, []), input('margined', cellsOf(2, 2), undefined, {
    portals: [{ id: 'north', axis: 'h', x: 0, y: 0, length: 2 }, { id: 'south', axis: 'h', x: 0, y: 2, length: 2 }],
  }),
    input('zero', cells, fill, { parameters: { density: 0 } })]) {
    assert.equal(COVER_EXECUTION.build(rejected).elements.length, 0);
    assert.match(COVER_EXECUTION.receiving(rejected), /no usable placement/);
  }
  assert.throws(() => COVER_EXECUTION.build(input('bad', cells, fill, { parameters: { density: 2 } })), /density must be/);
});

test('separate residual pieces retain doorway spacing and canonical input order', () => {
  const cells = cellsOf(14, 8), fill = cells.filter(c => c.y >= 3 && c.y <= 5
    && (c.x >= 2 && c.x <= 4 || c.x >= 9 && c.x <= 11));
  const brief = input('spaced', cells, fill, { seed: 4, zones: [{ tier: 2, bonus: 0, lootChance: 0, cells }] });
  assert.equal(buildCover(brief).elements.length, 0);
  const result = COVER_EXECUTION.build(brief);
  assert.equal(result.elements.length, 2);
  const [a, b] = result.elements.map(footprint);
  const dx = Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w);
  const dy = Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h);
  assert.ok(dx >= 2 || dy >= 2, 'pieces leave a two-cell doorway between extents');
  const reversed = structuredClone(brief);
  reversed.cells.reverse(); reversed.fillCells.reverse(); reversed.zones[0].cells.reverse();
  const reordered = COVER_EXECUTION.build(reversed);
  assert.deepEqual({ elements: reordered.elements, loot: reordered.loot, manifest: reordered.manifest },
    { elements: result.elements, loot: result.loot, manifest: result.manifest });
});

test('inherited fill and portal obligations survive fallback; large portal sets keep ordinary output', () => {
  const cells = cellsOf(70, 8), fill = cells.filter(c => c.x >= 35 && c.x <= 37 && c.y >= 3 && c.y <= 5);
  const portals = Array.from({ length: 33 }, (_, i) => ({ id: `north-${i}`, axis: 'h', x: i * 2, y: 0, length: 2 }));
  for (const [id, active] of [['two', [portals[0], portals[32]]], ['many', portals]]) {
    const brief = input(id, cells, fill, { portals: active,
      zones: [{ tier: 2, bonus: 0, lootChance: 0, cells }] });
    assert.equal(buildCover(brief).elements.length, 0);
    const result = COVER_EXECUTION.build(brief);
    if (id === 'two') assert.ok(result.elements.length, 'the routed child places cover');
    else assert.deepEqual(result, buildCover(brief), 'the high-portal child remains bounded');
    assert.deepEqual(validateFillConstraints(brief, blockers(result)), []);
    assert.deepEqual(validatePortalReach({ ...brief, blockers: blockers(result) }).errors, []);
  }
});

test('fallback preserves the hunter crossing between opposite portals', () => {
  const cells = cellsOf(10, 8), fill = cells.filter(c => c.x >= 4 && c.x <= 6 && c.y >= 2 && c.y <= 6);
  const brief = input('crossing', cells, fill, { portals: [
    { id: 'west', axis: 'v', x: 0, y: 3, length: 2 },
    { id: 'east', axis: 'v', x: 10, y: 3, length: 2 },
  ], zones: [{ tier: 2, bonus: 0, lootChance: 0, cells }] });
  assert.equal(buildCover(brief).elements.length, 0);
  const result = COVER_EXECUTION.build(brief);
  assert.ok(result.elements.length);
  assert.deepEqual(validateFillConstraints(brief, blockers(result)), []);
  assert.deepEqual(validatePortalReach({ ...brief, blockers: blockers(result) }).errors, []);
});

test('ordinary clustered cover and standalone results stay identical', () => {
  const cells = cellsOf(16, 16), brief = input('ordinary', cells, cells, { parameters: { density: 1 } });
  const normal = buildCover(brief);
  assert.ok(normal.elements.length);
  assert.deepEqual(COVER_EXECUTION.build(brief), normal);
  assert.deepEqual(previewedCoverExecution().build(brief), normal);
  assert.deepEqual(buildCover(brief), normal);
});
