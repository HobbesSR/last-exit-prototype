import test from 'node:test';
import assert from 'node:assert/strict';
import { perimeterRuns, perimeterWalls, reachPerimeter } from '../map/micro/sdk.ts';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { createFillMask } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { cellsOf } from './helpers/cells.js';
import { createAddressedArea } from '../map/micro/addressed.ts';

const make = (w, h, cellSize = 40) => ({ id: 'perimeter', seed: 1, type: 'open', cellSize,
  cells: cellsOf(w, h), zones: [], portals: [] });

test('explicit unhinted long runs respect macro fill, internal clear cells and portal end caps', () => {
  const b = { ...make(18, 6), portals: [{ id: 'north', axis: 'h', x: 7, y: 0, length: 3 }],
    internalGuaranteed: [{ axis: 'v', x: 3, y: 0, length: 4 }] };
  const runs = [{ axis: 'h', x: 0, y: 0, length: 18 }];
  const planned = perimeterWalls(b, { runs, kind: 'ruin-wall' });
  assert.ok(planned.cells.some(c => c.x === 17));
  assert.ok(planned.elements.length > 1);
  const fill = createFillMask(b);
  assert.ok(planned.shapes.every(s => fill.contains(s)));
  assert.ok(planned.cells.every(c => !(c.x >= 6 && c.x <= 10) && c.x !== 2 && c.x !== 3));
  assert.deepEqual(perimeterWalls(b, { kind: 'building' }).elements, []);
  assert.deepEqual(perimeterWalls({ ...b, hints: runs }, { runs: [], kind: 'building' }).elements, []);
  assert.throws(() => perimeterWalls(b, { runs: [{ axis: 'h', x: 0, y: 1, length: 18 }], kind: 'building' }), /perimeter/);
});

test('opposing long perimeter walls keep only the side that leaves hunter clearance', () => {
  for (const cellSize of [20, 40]) {
    const b = { ...make(18, 2, cellSize), portals: [
      { id: 'west', axis: 'v', x: 0, y: 0, length: 2 },
      { id: 'east', axis: 'v', x: 18, y: 0, length: 2 },
    ] };
    const runs = [{ axis: 'h', x: 0, y: 0, length: 18 }, { axis: 'h', x: 0, y: 2, length: 18 }];
    const options = { runs, kind: 'building', thickness: 0.1 };
    const candidate = perimeterWalls(b, options);
    assert.equal(candidate.elements.length, 2);
    assert.equal(validatePortalReach({ ...b, blockers: candidate.shapes }, { search: 'thorough' }).valid, false);
    const created = createProspectiveParcels(b);
    assert.equal(created.ok, true);
    // The JS API must not eagerly mark even an accidentally supplied external ledger.
    const external = createAddressedArea(createFillMask(b));
    const kept = reachPerimeter(created.coordinator, b, { ...options, addressed: external });
    assert.deepEqual(external.areas, []);
    assert.equal(kept.elements.length, 1);
    assert.equal(kept.elements[0].label, 'perimeter-wall-h-1-0');
    assert.deepEqual(created.coordinator.elements, kept.elements);
    assert.equal(created.coordinator.addressed.addressed(8, 0), true);
    assert.equal(created.coordinator.addressed.addressed(8, 1), false);
    assert.equal(validatePortalReach({ ...b, blockers: kept.shapes }, { search: 'thorough' }).valid, true);
    // Rejected geometry acquires no canvas intent; replay and shuffled owned cells are deterministic.
    const again = createProspectiveParcels({ ...b, cells: [...b.cells].reverse() });
    assert.equal(again.ok, true);
    assert.deepEqual(reachPerimeter(again.coordinator, b, options), kept);
  }
});

test('perimeterRuns lists the hints, then every stretch no portal or hint holds, for runs', () => {
  // An 8 × 6 region: a portal on the north face at columns 2–3, a hint down the west face.
  const west = { axis: 'v', x: 0, y: 0, length: 6, stated: { inside: 'not-passable-hint', across: 'any' } };
  const b = { ...make(8, 6), portals: [{ id: 'p', axis: 'h', x: 2, y: 0, length: 2 }], hints: [west] };
  assert.deepEqual(perimeterRuns(b), [west]);
  const runs = perimeterRuns(b, 'unguaranteed');
  assert.deepEqual(runs, [west,
    { axis: 'h', x: 0, y: 0, length: 2 }, { axis: 'h', x: 4, y: 0, length: 4 },
    { axis: 'h', x: 0, y: 6, length: 8 }, { axis: 'v', x: 8, y: 0, length: 6 }]);
  assert.throws(() => perimeterRuns(b, 'all'), RangeError);
  // Every run is one a wall can take: the region on one side. The portal's strip and end
  // caps (columns 1–4 of row 0) stay clear through the fill mask.
  const walls = perimeterWalls(b, { runs, kind: 'building' });
  // West 6, north 3 (columns 5–7; column 0 is the west corner), south 7 and east 4 beyond the corners.
  assert.equal(walls.cells.length, 6 + 3 + 7 + 4);
  for (const cell of ['1,0', '2,0', '3,0', '4,0']) assert.equal(walls.cells.some(c => `${c.x},${c.y}` === cell), false, cell);
  // A concave region's notch is perimeter too: an L of three cells has six runs.
  assert.equal(perimeterRuns({ cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, 'unguaranteed').length, 6);
});
