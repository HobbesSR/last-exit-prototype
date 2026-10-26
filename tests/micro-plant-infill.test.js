import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createFillMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { latticeSlots } from '../map/micro/strategies/lattice.ts';
import { draw } from '../map/micro/random.ts';
import { portalMargin } from '../map/micro/hints.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { bounds, circle, rect } from '../shared/shape.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const cells = cellsOf(32, 24);
const portals = [{ id: 'west', axis: 'v', x: 0, y: 9, length: 3 },
  { id: 'east', axis: 'v', x: 32, y: 12, length: 3 }];
const brief = (owned = cells, density = 0.8, shed = 1) => ({ id: 'plant-infill', seed: 7, type: 'plant', cellSize: SIZE,
  cells: owned, zones: [{ tier: 3, bonus: 0, lootChance: 1, cells: owned }], portals, parameters: { density, shed } });
const crates = result => result.elements.filter(e => e.label.startsWith('plant-infill-crate-'));
const primary = result => result.elements.filter(e => !e.label.startsWith('plant-infill-crate-'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cellBox = element => ({ x: element.x / SIZE, y: element.y / SIZE,
  w: element.template.w / SIZE, h: element.template.h / SIZE });
const gap = (a, b) => Math.max(b.x - a.x - a.w, a.x - b.x - b.w,
  b.y - a.y - a.h, a.y - b.y - b.h);

test('plant infill preserves primary geometry with canonical candidate order', () => {
  const input = brief();
  const result = buildRegion(input);
  const reverse = buildRegion(brief([...cells].reverse()));
  assert.deepEqual(reverse.elements, result.elements);
  assert.deepEqual(reverse.loot, result.loot);
  assert.ok(crates(result).length > 0);
  assert.equal(result.manifest.infillCrates, crates(result).length);
  assert.deepEqual(crates(result).map(e => e.label), crates(result).map((_, i) => `plant-infill-crate-${i + 1}`));
  // Primary elements are committed before the infill pass.
  assert.equal(digest(primary(result)), '0769ba0f68eb81408dd3c5bed6f6c2c11b47787e084c5b79eca45978d5a5caf7');
});

test('crates occupy only machine-roll slots and keep lattice aisles, shed and pipe stubs clear', () => {
  const input = brief(), result = buildRegion(input), placed = crates(result), access = createAccessMask(input);
  const slots = latticeSlots(input, createFillMask(input), 8, { x: 1, y: 2 });
  const shed = result.elements.find(e => e.label.startsWith('plant-shed-'));
  const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
  assert.ok(placed.length > 0);
  for (const crate of placed) {
    const b = cellBox(crate);
    assert.deepEqual([b.w, b.h], [1, 1]);
    assert.equal(crate.template.parts[0].kind, 'crate');
    const slot = slots.find(s => b.x >= s.x && b.x < s.x + 8 && b.y >= s.y && b.y < s.y + 8);
    assert.ok(slot, crate.label);
    assert.ok(b.x < slot.x + 6 && b.y < slot.y + 6, `${crate.label} stays out of the two-cell lattice aisles`);
    assert.ok(draw(input.seed, slot.x, slot.y, 3) < input.parameters.density, `${crate.label} passed the original machine roll`);
    assert.ok(!shed || gap(b, cellBox(shed)) >= 2, `${crate.label} clears shed`);
    assert.ok(!reserved.has(`${b.x},${b.y}`));
    assert.ok(access.contains(rect(crate.x - 2 * SIZE, crate.y - 2 * SIZE, 5 * SIZE, 5 * SIZE)), `${crate.label} has a full bypass ring`);
    for (const other of result.elements) if (other !== crate) {
      // Pipe templates include the doorway gap and seated ends. Their committed
      // extents are the separate stub areas, which are the spacing boundary.
      const extents = other.label.startsWith('plant-pipe-') ? elementShapes(other).map(bounds)
        .map(extent => ({ x: extent.x / SIZE, y: extent.y / SIZE, w: extent.w / SIZE, h: extent.h / SIZE }))
        : [cellBox(other)];
      for (const e of extents) {
        assert.ok(gap(b, e) >= 2, `${crate.label} clears ${other.label}`);
      }
    }
  }
  const shapes = result.elements.flatMap(e => elementShapes(e, true));
  assert.deepEqual(validatePortalReach({ ...input, blockers: shapes }).errors, []);
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  for (const site of result.loot) assert.ok(shapes.every(shape => !shapesOverlap(circle(site.x, site.y, radius), shape)));

  const shedInput = { ...brief(cellsOf(40, 30), 1, 1), seed: 1, portals: [] };
  const withShed = buildRegion(shedInput), building = withShed.elements.find(e => e.label.startsWith('plant-shed-'));
  assert.ok(building && crates(withShed).length > 0);
  const occupiedSlots = latticeSlots(shedInput, createFillMask(shedInput), 8, { x: 1, y: 2 })
    .filter(slot => slot.x >= building.x / SIZE && slot.y >= building.y / SIZE
      && slot.x < (building.x + building.template.w) / SIZE && slot.y < (building.y + building.template.h) / SIZE);
  for (const crate of crates(withShed)) for (const slot of occupiedSlots)
    assert.ok(crate.x / SIZE < slot.x || crate.x / SIZE >= slot.x + 6
      || crate.y / SIZE < slot.y || crate.y / SIZE >= slot.y + 6, `${crate.label} avoids shed slots`);
});

test('plant infill retains primary-accessible side lobes across narrow necks', () => {
  const compared = { single: 0, multiple: 0 };
  for (const width of [2, 3]) for (const seed of [3, 25]) for (const multiple of [false, true]) {
    const owned = cellsOf(36, 24, (x, y) => x < 12 || x >= 20 || (y >= 10 && y < 10 + width));
    const entrances = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 2 },
      ...multiple ? [{ id: 'north', axis: 'h', x: 5, y: 0, length: 2 }] : []];
    const input = { ...brief(owned, 0.8, 0), seed, portals: entrances,
      zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells: owned }] };
    const result = buildRegion(input), access = createAccessMask(input), start = portalStands(input)[0].points[0];
    const original = primary(result).flatMap(e => elementShapes(e));
    const final = result.elements.flatMap(e => elementShapes(e));
    const route = (blockers, end, radius) => findRegionRoute(access, blockers, start, end, radius);
    const far = { x: 31.5 * SIZE, y: 11.5 * SIZE };
    if (route(original, far, hunterClearance(SIZE))) {
      compared[multiple ? 'multiple' : 'single']++;
      assert.ok(route(final, far, hunterClearance(SIZE)), `width ${width}, seed ${seed}, multiple ${multiple}`);
    }
    const contestant = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
    for (const site of result.loot.filter(site => site.x >= 20 * SIZE).slice(0, 12))
      if (route(original, site, contestant)) assert.ok(route(final, site, contestant), `far loot ${site.x},${site.y}`);
    for (const crate of crates(result))
      assert.ok(access.contains(rect(crate.x - 2 * SIZE, crate.y - 2 * SIZE, 5 * SIZE, 5 * SIZE)));
  }
  assert.ok(compared.single > 0 && compared.multiple > 0, `${JSON.stringify(compared)} primary-accessible side lobes compared`);
});

test('density zero keeps the optional shed but adds no crates, and small regions retain fallback', () => {
  const empty = buildRegion(brief(cells, 0, 0));
  assert.equal(empty.elements.length, 0);
  assert.equal(empty.manifest.infillCrates, 0);
  const traces = [];
  const shed = buildRegion({ ...brief(cellsOf(40, 30), 0, 1), seed: 1, portals: [] }, undefined, trace => traces.push(trace));
  assert.equal(shed.manifest.infillCrates, 0);
  assert.equal(crates(shed).length, 0);
  assert.ok(shed.elements.some(e => e.label.startsWith('plant-shed-')));
  assert.equal(digest(traces), 'dacde3df60e1e2d3223a5efe864ff2f4837ae1825e259d71d30e640d63355bbb');
  const thin = buildRegion(brief(cellsOf(32, 9), 1, 0));
  assert.equal(thin.elements.length, 0);
  assert.equal(thin.manifest.infillCrates, undefined);
});
