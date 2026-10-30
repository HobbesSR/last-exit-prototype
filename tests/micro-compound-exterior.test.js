import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { buildCompoundExterior } from '../map/micro/strategies/compound-exterior.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap, travelClear } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle, rect } from '../shared/shape.ts';
import { brief, compoundBox, MASKS, SIZE } from './helpers/compound-fixtures.js';
import { cellsOf } from './helpers/cells.js';

const oldHashes = { field: '158a963fcc25465b5af6e5bcc973c5485b61d013034bfcdeb8a83f915842ed35',
  ell: 'f149a2a762235e36a5320cafc5207d79827c579adc88b13d466bc0310998a630' };
const json = value => JSON.parse(JSON.stringify(value));
const make = name => brief(`exterior-${name}`, 1, ...MASKS[name]);
function center(trace, space) {
  const xs = space.cells.map(c => c.x), ys = space.cells.map(c => c.y);
  return { x: trace.origin.x + (Math.min(...xs) + Math.max(...xs) + 1) * SIZE / 2,
    y: trace.origin.y + (Math.min(...ys) + Math.max(...ys) + 1) * SIZE / 2 };
}
function openingCenter(trace, opening) {
  const { axis, x, y } = opening.run;
  return { x: trace.origin.x + (x + (axis === 'h' ? opening.center : 0)) * SIZE,
    y: trace.origin.y + (y + (axis === 'v' ? opening.center : 0)) * SIZE };
}
function gateStand(gate, ring) {
  const p = { x: gate.x + gate.template.w / 2, y: gate.y + gate.template.h / 2 };
  const side = gate.label.at(-1);
  if (side === 'N') p.y = (ring.y - 1) * SIZE;
  if (side === 'S') p.y = (ring.y + ring.h + 1) * SIZE;
  if (side === 'W') p.x = (ring.x - 1) * SIZE;
  if (side === 'E') p.x = (ring.x + ring.w + 1) * SIZE;
  return p;
}

for (const name of ['field', 'ell']) test(`${name} exterior house has clear bypass and reachable rooms, doors and gates`, () => {
  const input = make(name), traces = [], result = buildRegion(input, undefined, t => traces.push(t));
  const houses = result.elements.filter(e => e.label === 'compound-outbuilding');
  assert.equal(houses.length, 1);
  const house = houses[0], trace = traces.find(t => t.label === 'compound-outbuilding');
  assert.ok(trace);
  const old = result.elements.filter(e => /^compound-(room|gate|keep|court)/.test(e.label));
  assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'), oldHashes[name], 'ring and court retain their baseline geometry');
  const ring = compoundBox(result), x = house.x / SIZE, y = house.y / SIZE, w = house.template.w / SIZE, h = house.template.h / SIZE;
  assert.ok(x + w + 2 <= ring.x || ring.x + ring.w + 2 <= x || y + h + 2 <= ring.y || ring.y + ring.h + 2 <= y);
  const access = createAccessMask(input), others = result.elements.filter(e => e !== house).flatMap(e => elementShapes(e, true));
  for (let cy = y - 2; cy < y + h + 2; cy++) for (let cx = x - 2; cx < x + w + 2; cx++) {
    if (cx >= x && cx < x + w && cy >= y && cy < y + h) continue;
    assert.ok(access.has(cx, cy), `collar cell ${cx},${cy} belongs to access mask`);
    const cell = rect(cx * SIZE, cy * SIZE, SIZE, SIZE);
    assert.ok(others.every(shape => !shapesOverlap(cell, shape)), `collar cell ${cx},${cy} is clear`);
  }
  const shapes = result.elements.flatMap(e => elementShapes(e)), placed = result.elements.flatMap(e => elementShapes(e, true));
  assert.deepEqual(validateFillConstraints(input, placed), []);
  assert.deepEqual(validatePortalReach({ ...input, blockers: shapes }).errors, []);
  const starts = portalStands(input).flatMap(p => p.points), radius = hunterClearance(SIZE);
  const targets = trace.allocation.spaces.map(s => ({ label: s.id, point: center(trace, s) }));
  for (const opening of trace.realization.openings.filter(o => o.kind === 'door')) {
    const p = openingCenter(trace, opening);
    for (const offset of [-1, 0, 1]) targets.push({ label: `${opening.connectionId}/${offset}`,
      point: { x: p.x + (opening.run.axis === 'v' ? offset * SIZE : 0), y: p.y + (opening.run.axis === 'h' ? offset * SIZE : 0) } });
  }
  for (const gate of result.elements.filter(e => e.label.startsWith('compound-gate')))
    targets.push({ label: gate.label, point: gateStand(gate, ring) });
  for (const target of targets) {
    const start = [...starts].sort((a, b) => Math.hypot(a.x-target.point.x,a.y-target.point.y) - Math.hypot(b.x-target.point.x,b.y-target.point.y))[0];
    assert.ok(findRegionRoute(access, shapes, start, target.point, radius), `${target.label} is reachable`);
  }
  const lootRadius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length, 'the exclusion check exercises generated loot');
  for (const loot of result.loot) assert.ok(placed.every(s => !shapesOverlap(circle(loot.x, loot.y, lootRadius), s)), 'loot clears all walls and doors');
});

test('an odd-width fallback retains every collar cell and reachable exterior standing point', () => {
  const input = brief('odd-exterior', 1, cellsOf(19, 14), []);
  const ring = { x: 2, y: 2, w: 10, h: 10 }, gate = { x: 12, y: 5 };
  const result = buildCompoundExterior(input, ring, [gate]);
  assert.equal(result.elements.length, 1);
  const [box] = result.boxes;
  assert.deepEqual([box.w, box.h], [3, 4]);
  const protectedCells = new Set(result.steps.flatMap(p => [0, 1].flatMap(dy => [0, 1].map(dx => `${p.x + dx},${p.y + dy}`))));
  for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++) {
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
    assert.ok(protectedCells.has(`${x},${y}`), `odd collar cell ${x},${y} remains fixed`);
  }
  const shape = b => rect(b.x * SIZE, b.y * SIZE, b.w * SIZE, b.h * SIZE);
  const mask = createAccessMask(input), radius = hunterClearance(SIZE);
  const point = (x, y) => ({ x: (x + 1) * SIZE, y: (y + 1) * SIZE });
  // Independent swept-circle geometry, rather than the composer's cell-square predicate.
  const flood = blockers => {
    const queue = [gate], reached = new Map([[`${gate.x},${gate.y}`, point(gate.x, gate.y)]]);
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head], from = point(at.x, at.y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = at.x + dx, y = at.y + dy, key = `${x},${y}`, to = point(x, y);
        if (reached.has(key) || !travelClear(mask, blockers, from, to, radius)) continue;
        reached.set(key, to); queue.push({ x, y });
      }
    }
    return reached;
  };
  const before = flood([shape(ring)]), blockers = [shape(ring), shape(box)], after = flood(blockers);
  let compared = 0;
  for (const [key, p] of before) if (travelClear(mask, blockers, p, p, radius)) {
    assert.ok(after.has(key), `existing exterior stand ${key} remains reachable`); compared++;
  }
  assert.ok(compared > 20, 'the flood compares surrounding yard and side pockets');
});

test('compact yard declines an exterior house', () => {
  const result = buildRegion(brief('exterior-compact', 1, cellsOf(14, 14), []));
  assert.ok(result.elements.some(e => e.label.startsWith('compound-room')));
  assert.ok(!result.elements.some(e => e.label === 'compound-outbuilding'));
});

test('outbuilding is deterministic under reversed cells, portals and zones', () => {
  const input = make('field');
  input.zones = [{ tier: 1, bonus: 0, lootChance: 0.2, cells: input.cells.filter(c => c.x < 20) },
    { tier: 2, bonus: 0, lootChance: 0.3, cells: input.cells.filter(c => c.x >= 20) }];
  const first = buildRegion(input), reversed = buildRegion({ ...input, cells: [...input.cells].reverse(), portals: [...input.portals].reverse(),
    zones: [...input.zones].reverse().map(z => ({ ...z, cells: [...z.cells].reverse() })) });
  assert.ok(first.elements.some(e => e.label === 'compound-outbuilding'));
  assert.deepEqual(reversed.elements, first.elements);
  assert.deepEqual(reversed.loot, first.loot);
});

test('full and omitted snapshots recover the outbuilding observer event and result', () => {
  const node = buildCompoundGeneration(make('field')), flat = flattenDelegationResult(node);
  assert.equal(node.observerEvents.filter(e => e.label === 'compound-outbuilding').length, 1);
  for (const options of [{}, { omitResults: true }]) {
    const snapshot = json(saveDelegationSnapshot(node, options));
    assert.deepEqual(readDelegationSnapshot(snapshot, COMPOUND_EXECUTION_REGISTRY), node);
    assert.deepEqual(delegationSnapshotResult(snapshot, COMPOUND_EXECUTION_REGISTRY), flat);
  }
});
