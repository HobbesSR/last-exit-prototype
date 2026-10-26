import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { portalMargin } from '../map/micro/hints.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { bounds, circle } from '../shared/shape.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const brief = (cells, density, portals = []) => ({ id: 'infill', seed: 1, type: 'depot', cellSize: SIZE,
  cells, zones: [{ tier: 2, bonus: 0, lootChance: 1, cells }], portals,
  parameters: { density, roomCells: 6 } });
const box = element => ({ x: element.x / SIZE, y: element.y / SIZE,
  w: element.template.w / SIZE, h: element.template.h / SIZE });
const primary = result => result.elements.filter(e => !e.label.startsWith('depot-infill-crate-'));
const crates = result => result.elements.filter(e => e.label.startsWith('depot-infill-crate-'));

test('depot infill retains the seeded primary layout and deliberate empty row spans', () => {
  const cells = cellsOf(20, 16), input = brief(cells, 0.5);
  const result = buildRegion(input), reversed = buildRegion(brief([...cells].reverse(), 0.5));
  assert.deepEqual(primary(result).map(e => [e.label, ...Object.values(box(e))]), [
    ['depot-warehouse-1', 5, 10, 6, 5],
    ['depot-row-1', 0, 1, 4, 1],
    ['depot-row-2', 6, 1, 4, 1],
    ['depot-row-3', 12, 1, 6, 1],
  ]);
  assert.deepEqual(reversed.elements, result.elements, 'canonical cell order');
  assert.equal(result.manifest.infillCrates, crates(result).length);
  assert.ok(crates(result).length > 0);
  // The geometrically valid row site x=0..3, y=4 lost its density roll. Its
  // whole span stays open even though the next cell becomes a crate.
  assert.ok(crates(result).some(e => e.x === 4 * SIZE && e.y === 4 * SIZE));
  assert.ok(crates(result).every(e => e.y !== 4 * SIZE || e.x >= 4 * SIZE));
  assert.ok(crates(result).every(e => box(e).w === 1 && box(e).h === 1));
  assert.ok(crates(result).every(e => box(e).y % 3 === 1), 'same seeded lane phase');
});

test('depot density zero stays empty, while infill respects margins, routes and loot clearance', () => {
  const cells = cellsOf(24, 20);
  const portals = [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
    { id: 'east', axis: 'v', x: 24, y: 11, length: 3 }];
  const empty = buildRegion(brief(cells, 0, portals));
  assert.equal(empty.elements.length, 0);
  assert.equal(empty.manifest.infillCrates, 0);

  const input = brief(cells, 0.65, portals), result = buildRegion(input);
  assert.ok(crates(result).length > 0);
  assert.ok(primary(result).some(e => e.label.startsWith('depot-warehouse-')));
  const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
  for (const element of crates(result)) {
    const b = box(element);
    assert.ok(cells.some(c => c.x === b.x && c.y === b.y));
    assert.ok(!reserved.has(`${b.x},${b.y}`));
    assert.equal(element.template.parts[0].kind, 'crate');
    for (const other of result.elements) if (other !== element) {
      const o = box(other);
      const gap = Math.max(o.x - b.x - b.w, b.x - o.x - o.w, o.y - b.y - b.h, b.y - o.y - o.h);
      assert.ok(gap >= 2, `${element.label} spacing from ${other.label}`);
    }
  }
  const shapes = result.elements.flatMap(e => elementShapes(e, true));
  assert.deepEqual(validatePortalReach({ ...input, blockers: shapes }).errors, []);
  const lootRadius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  for (const site of result.loot) assert.ok(shapes.every(shape => !shapesOverlap(circle(site.x, site.y, lootRadius), shape)));
  assert.ok(result.loot.length > 0);
  assert.ok(bounds(shapes[0]).w > 0);
});
