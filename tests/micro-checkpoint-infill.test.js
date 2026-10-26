import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { createFillMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { portalMargin } from '../map/micro/hints.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const shapes = {
  yard: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
    { id: 'east', axis: 'v', x: 24, y: 12, length: 3 }, { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 12 || x < 12),
    [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 }]],
  one: [cellsOf(20, 16), [{ id: 'west', axis: 'v', x: 0, y: 6, length: 3 }]],
  tiny: [cellsOf(8, 4), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 4 },
    { id: 'east', axis: 'v', x: 8, y: 0, length: 4 }]],
};
// SHA-256 of { primary elements, observer traces } at pre-infill commit f775fe7.
const baseline = {
  yard: ['c10621626970cbaa02a6b3ca72d19dedd86dcd999d899c9c60e5d7822badba22', '09f0e58853644ff366a13185323c8ad36381b13109d7fcb82a5f1067386e2c6d'],
  ell: ['bf369333a976a67af719aa92d177b85bef82d3f75323def510ab5950dcb7ce97', 'c6ab028cdb52d01ef56fb4faa5e443b65947b0e07b870bd5a81ab281f1d9b307'],
  one: ['8ab387415972b0347eb6f39777eee3c3c147b5d6fe82c6d6bafb008d6d8a4e14', 'db0595e821377903544bc1e4fbe49786bbf5edc91c52130a91eb9dbad98c86f0'],
  tiny: ['40fb98ef94e60edc814fab653823a1b9af7b2f6a8310fdd91b303dbf534509e5', 'f15089f3c85bb14f492b21dac68e9de87cbb38df857cc0cc70c54c8555549594'],
};
const input = (name, seed, cells = shapes[name][0], portals = shapes[name][1]) => ({
  id: name, seed, type: 'checkpoint', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals,
});
const primary = result => result.elements.filter(e => !e.label.startsWith('checkpoint-infill-crate-'));
const crates = result => result.elements.filter(e => e.label.startsWith('checkpoint-infill-crate-'));
const box = e => rect(e.x, e.y, e.template.w, e.template.h);

test('infill preserves exact primary elements and observer traces from before the change', () => {
  for (const [name, hashes] of Object.entries(baseline)) for (const [i, seed] of [1, 4].entries()) {
    const seen = [], result = buildRegion(input(name, seed), undefined, building => seen.push(building));
    const hash = createHash('sha256').update(JSON.stringify({ elements: primary(result), seen })).digest('hex');
    assert.equal(hash, hashes[i], `${name} seed ${seed}`);
    assert.equal(result.manifest.infillCrates ?? 0, crates(result).length);
  }
});

test('side-yard crates follow canonical cells and keep whole-cell spacing, margins, loot and portal routes', () => {
  for (const name of ['yard', 'ell', 'one']) {
    const brief = input(name, 1), result = buildRegion(brief);
    assert.deepEqual(buildRegion(input(name, 1, [...brief.cells].reverse())).elements, result.elements, `${name} cell order`);
    assert.ok(crates(result).length > 0, `${name} receives infill`);
    const fill = createFillMask(brief), margin = new Set(portalMargin(brief, 1).map(c => `${c.x},${c.y}`));
    const centres = brief.portals.map(p => p.axis === 'h' ? { x: p.x + p.length / 2, y: p.y }
      : { x: p.x, y: p.y + p.length / 2 });
    const line = centres.length >= 2 ? [centres[0], centres[1]] : undefined;
    for (const [i, crate] of crates(result).entries()) {
      assert.equal(crate.label, `checkpoint-infill-crate-${i + 1}`);
      assert.equal(crate.template.parts[0].kind, 'crate');
      assert.equal(crate.template.w, SIZE);
      assert.equal(crate.template.h, SIZE);
      assert.ok(fill.contains(box(crate)));
      assert.ok(!margin.has(`${crate.x / SIZE},${crate.y / SIZE}`));
      if (line) for (let step = 0; step <= 100; step++) {
        const t = step / 100, x = line[0].x + (line[1].x - line[0].x) * t;
        const y = line[0].y + (line[1].y - line[0].y) * t;
        assert.ok(x <= crate.x / SIZE - 2 || x >= crate.x / SIZE + 3
          || y <= crate.y / SIZE - 2 || y >= crate.y / SIZE + 3,
        `${name}: ${crate.label} keeps the chicane corridor clear`);
      }
      for (const other of result.elements) if (other !== crate) {
        const a = box(crate), b = box(other);
        const gap = Math.max(b.x - a.x - a.w, a.x - b.x - b.w, b.y - a.y - a.h, a.y - b.y - b.h);
        assert.ok(gap >= 2 * SIZE, `${name}: ${crate.label} keeps an aisle from ${other.label}`);
      }
    }
    const blockers = result.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validatePortalReach({ ...brief, blockers }).errors, [], `${name} portal promise`);
    const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
    for (const site of result.loot) assert.ok(blockers.every(shape => !shapesOverlap(circle(site.x, site.y, radius), shape)));
  }
});

test('explicit reduced fill is honored and an open fallback stays open', () => {
  const brief = input('one', 4), clearCells = brief.cells.filter(c => c.x >= 12 && c.x < 15);
  const fillCells = brief.cells.filter(c => c.x < 12 || c.x >= 15);
  const result = buildRegion({ ...brief, fillCells, clearCells });
  assert.ok(crates(result).length > 0);
  assert.ok(crates(result).every(e => fillCells.some(c => c.x * SIZE === e.x && c.y * SIZE === e.y)));
  const small = cellsOf(2, 2), open = buildRegion(input('open', 1, small, []));
  assert.equal(open.elements.length, 0);
  assert.equal(crates(open).length, 0);
});
