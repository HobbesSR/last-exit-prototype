import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { portalMargin } from '../map/micro/hints.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { bounds, circle } from '../shared/shape.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { cellsOf } from './helpers/cells.js';
import { draw } from '../map/micro/random.ts';

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
  assert.ok(primary(result).some(e => e.label.startsWith('depot-warehouse-')));
  assert.ok(primary(result).some(e => e.label.startsWith('depot-row-')));
  assert.deepEqual(reversed.elements, result.elements, 'canonical cell order');
  assert.equal(result.manifest.infillCrates, crates(result).length);
  assert.ok(crates(result).length > 0);
  assert.ok(crates(result).every(e => box(e).w === 1 && box(e).h === 1));
  assert.ok(crates(result).every(e => box(e).y % 3 === 1), 'same seeded lane phase');
});

test('a density-skipped row remains empty even where an infill roll would succeed', () => {
  const cells = cellsOf(30, 24), result = buildRegion(brief(cells, 0.5));
  // Seed 1 takes the horizontal lane at y=13. The viable x=13..18 row
  // loses its row roll, while the infill roll for (13,13) would pass.
  assert.ok(draw(1, 13, 13, 4) >= 0.5);
  assert.ok(draw(1, 13, 13, 8) < 0.5);
  assert.ok(result.elements.some(e => e.label === 'depot-row-3' && box(e).x === 21 && box(e).y === 13));
  const witness = { x: 13, y: 13, w: 1, h: 1 };
  for (const element of result.elements) {
    const o = box(element);
    const gap = Math.max(o.x - witness.x - 1, witness.x - o.x - o.w, o.y - witness.y - 1, witness.y - o.y - o.h);
    assert.ok(gap >= 2, `${element.label} leaves the witness viable`);
  }
  assert.ok(crates(result).every(e => box(e).y !== 13 || box(e).x < 13 || box(e).x > 18));
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
