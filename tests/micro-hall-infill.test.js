import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createFillMask, elementShapes, shapesOverlap, findRegionRoute } from '../map/micro/geometry.ts';
import { largestRectangle } from '../map/micro/strategies/hall.ts';
import { portalStands, hunterClearance, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const size = 40;
const cells = cellsOf(30, 30, (x, y) => y < 14 || x < 14);
const brief = (owned = cells, extra = {}) => ({ id: 'hall-infill', seed: 7, type: 'hall', cellSize: size, cells: owned,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells: owned }], portals: [],
  hints: [{ axis: 'h', x: 0, y: 0, length: 30 }], ...extra });
const crates = r => r.elements.filter(e => e.label.startsWith('hall-infill-crate-'));
const primary = r => r.elements.filter(e => e.label === 'hall' || e.label.startsWith('hint-wall-'));
const narrow = cellsOf(30, 30, (x, y) => y < 14 || x < 5);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const gap = (a, b) => Math.max(b.x - a.x - a.w, a.x - b.x - b.w, b.y - a.y - a.h, a.y - b.y - b.h);
const box = (e, s) => ({ x: e.x / s, y: e.y / s, w: e.template.w / s, h: e.template.h / s });

test('residual hall infill preserves the original primary elements and roof', () => {
  for (const [roofed, hash] of [[false, '9f7cce7f5c5ab7289f1d787c25ece5aebad4e58b4d8253ac45f3dc1dcf259b6c'],
    [true, '7e2fa6824bcc432c8baa2f62d4d60f39563618850b7f4591f5e8f62f40acac02']]) {
    const input = brief(cells, { parameters: { roofed } }), result = buildRegion(input);
    assert.equal(digest(primary(result)), hash);
    assert.equal(result.manifest.infillCrates, crates(result).length);
    assert.deepEqual(buildRegion({ ...input, cells: [...cells].reverse() }).elements, result.elements);
    assert.deepEqual(buildRegion({ ...input, cells: [...cells].reverse() }).loot, result.loot);
    assert.equal(primary(result)[0].template.encloses, roofed || undefined);
  }
});

test('crates keep the primary rectangle, other extents, access ring, margins and loot clear', () => {
  for (const [owned, s] of [[narrow, size], [narrow.map(c => ({ x: c.x + 100, y: c.y - 70 })), 2.5]]) {
    const translated = s !== size;
    const input = brief(owned, { cellSize: s, hints: [], portals: translated ? [] : [{ id: 'west', axis: 'v', x: 0, y: 6, length: 2 }] });
    const result = buildRegion(input), access = createAccessMask(input), rectangle = largestRectangle(createFillMask(input), 6);
    assert.ok(crates(result).length > 0);
    for (const crate of crates(result)) {
      const b = box(crate, s);
      assert.ok(gap(b, rectangle) >= 2);
      assert.ok(access.contains(rect(crate.x - 2*s, crate.y - 2*s, 5*s, 5*s)));
      assert.ok(createFillMask(input).contains(rect(crate.x, crate.y, s, s)));
      for (const other of result.elements) if (other !== crate) assert.ok(gap(b, box(other, s)) >= 2 - 1e-7);
    }
    const shapes = result.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validatePortalReach({ ...input, blockers: shapes }).errors, []);
    const radius = microMetrics({ cellSize: s, bodyProfile: 'cell' }).lootRadius;
    for (const site of result.loot) assert.ok(shapes.every(shape => !shapesOverlap(circle(site.x, site.y, radius), shape)));
  }
});

test('single-portal side lobe remains accessible; rectangular halls and fallback stay clear', () => {
  const owned = narrow;
  const input = brief(owned, { seed: 1, hints: [], portals: [{ id: 'east', axis: 'v', x: 30, y: 5, length: 2 }] });
  const result = buildRegion(input), access = createAccessMask(input), start = portalStands(input)[0].points[0], end = { x: 2.5*size, y: 21.5*size };
  assert.ok(crates(result).length > 0);
  assert.ok(findRegionRoute(access, primary(result).flatMap(e => elementShapes(e)), start, end, hunterClearance(size)));
  assert.ok(findRegionRoute(access, result.elements.flatMap(e => elementShapes(e)), start, end, hunterClearance(size)));
  const rectangle = buildRegion(brief(cellsOf(20, 20), { hints: [] }));
  assert.equal(rectangle.manifest.infillCrates, 0);
  const fallback = buildRegion(brief(cellsOf(20, 5), { hints: [] }));
  assert.equal(fallback.manifest.infillCrates, undefined);
  assert.equal(fallback.elements.length, 0);
});

test('market uses its own stalls rather than hall residual infill', () => {
  const result = buildRegion(brief(cells, { type: 'market', parameters: { roofed: true } }));
  assert.ok(result.manifest.stalls > 0);
  assert.equal(result.manifest.awnings, result.manifest.stalls);
  assert.equal(result.manifest.infillCrates, undefined);
  assert.equal(crates(result).length, 0);
  assert.ok(result.elements.every(element => element.label.startsWith('market-stall-')));
});

test('the primary rectangle stays reserved when all pillars are protected away', () => {
  const input = brief(narrow, { hints: [], parameters: { spacing: 100 }, portals: [
    { id: 'west', axis: 'v', x: 0, y: 5, length: 2 },
    { id: 'east', axis: 'v', x: 30, y: 5, length: 2 },
  ] });
  const result = buildRegion(input), rectangle = largestRectangle(createFillMask(input), 6);
  assert.equal(primary(result).length, 0);
  assert.ok(crates(result).length > 0);
  for (const crate of crates(result)) assert.ok(gap(box(crate, size), rectangle) >= 2);
});
