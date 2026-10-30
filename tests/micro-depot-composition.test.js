import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesShareArea } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const makeBrief = (cells, portals, density = 1) => ({ id: 'composition', seed: 1, type: 'depot', cellSize: SIZE,
  cells, zones: [{ tier: 2, bonus: 0, lootChance: 0, cells }], portals, parameters: { density, roomCells: 6 } });

function checkGeometry(input, result, traces) {
  const mask = createAccessMask(input), open = result.elements.flatMap(e => elementShapes(e));
  const closed = result.elements.flatMap(e => elementShapes(e, true));
  const stands = portalStands(input).flatMap(s => s.points);
  assert.deepEqual(validatePortalReach({ ...input, blockers: open }, { search: 'thorough' }).errors, []);
  for (const e of result.elements.filter(e => e.label.startsWith('depot-warehouse-'))) {
    const trace = traces.find(t => t.label === e.label);
    assert.ok(trace);
    const outside = [];
    for (const door of trace.realization.openings.filter(o => o.kind === 'door' && (o.a === 'outside' || o.b === 'outside'))) {
      const { run, center } = door, horizontal = run.axis === 'h', start = (horizontal ? run.x : run.y) + center - 1;
      for (const along of new Set([Math.floor(start), Math.ceil(start)])) {
        const p = horizontal ? { x: e.x + (along + 1) * SIZE, y: e.y + (run.y === 0 ? -1 : e.template.h / SIZE + 1) * SIZE }
          : { x: e.x + (run.x === 0 ? -1 : e.template.w / SIZE + 1) * SIZE, y: e.y + (along + 1) * SIZE };
        const square = rect(p.x - SIZE, p.y - SIZE, 2 * SIZE, 2 * SIZE);
        assert.ok(mask.contains(square), `${e.label} doorstep contained`);
        assert.ok(closed.every(shape => !shapesShareArea(shape, square)), `${e.label} doorstep clear`);
        assert.ok(stands.some(stand => findRegionRoute(mask, open, stand, p, hunterClearance(SIZE))), `${e.label} doorstep reachable`);
        outside.push(p);
      }
    }
    assert.ok(outside.length >= 2);
    for (const space of trace.allocation.spaces) assert.ok(space.cells.some(c => findRegionRoute(mask, open, outside[0],
      { x: e.x + (c.x + 0.5) * SIZE, y: e.y + (c.y + 0.5) * SIZE }, microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant)),
    `${e.label} room ${space.id} reachable`);
  }
}

test('multiple warehouses retain real door and room access after all yard pieces are placed', () => {
  const cells = cellsOf(40, 30), portals = [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 },
    { id: 'east', axis: 'v', x: 40, y: 15, length: 3 }];
  const input = makeBrief(cells, portals), traces = [];
  const result = buildRegion(input, undefined, t => traces.push(t));
  assert.ok(result.manifest.warehouses >= 3, 'composition produces several warehouses');
  assert.ok(result.manifest.rows > 0, 'subsequent rows also occupy the yard');
  checkGeometry(input, result, traces);
});

test('unported disconnected lobe cannot receive a warehouse', () => {
  const cells = cellsOf(60, 25, (x, y) => x < 25 || x >= 35 || y === 12);
  const input = makeBrief(cells, [{ id: 'west', axis: 'v', x: 0, y: 10, length: 3 }]), traces = [];
  const result = buildRegion(input, undefined, t => traces.push(t));
  assert.ok(result.manifest.warehouses > 0);
  assert.ok(result.elements.filter(e => e.label.startsWith('depot-warehouse-')).every(e => e.x / SIZE < 25));
  checkGeometry(input, result, traces);
});


test('production warehouse budget can exceed the former quarter-fill quota', () => {
  const cells = cellsOf(30, 30), input = { ...makeBrief(cells, [], 0.55), seed: 2 };
  const result = buildRegion(input);
  const formerQuota = Math.max(1, Math.round(0.55 * cells.length / (4 * 6 * 5)));
  assert.equal(formerQuota, 4);
  assert.ok(result.manifest.warehouses > formerQuota, `built ${result.manifest.warehouses} warehouses`);
});

test('eligible small fill can place yard pieces even when no warehouse and zero density can place nothing', () => {
  const cells = cellsOf(10, 10), input = makeBrief(cells, [], 1);
  input.parameters.roomCells = 8;
  const result = buildRegion(input);
  assert.equal(result.manifest.warehouses, 0);
  assert.ok(result.manifest.rows > 0, 'minimum-sized fill reached the yard pass');
  const empty = buildRegion({ ...input, parameters: { ...input.parameters, density: 0 } });
  assert.equal(empty.elements.length, 0);
  assert.equal(empty.manifest.warehouses, 0);
});

test('cell and portal ordering do not change depot output', () => {
  const cells = cellsOf(30, 24), portals = [{ id: 'west', axis: 'v', x: 0, y: 6, length: 3 },
    { id: 'east', axis: 'v', x: 30, y: 12, length: 3 }, { id: 'north', axis: 'h', x: 10, y: 0, length: 3 }];
  const input = makeBrief(cells, portals), original = buildRegion(input);
  const reversed = buildRegion({ ...input, cells: [...cells].reverse(), portals: [...portals].reverse() });
  assert.deepEqual(reversed.elements, original.elements);
  assert.deepEqual(reversed.manifest, original.manifest);
  assert.deepEqual(reversed.loot, original.loot);
});
