import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalReach, portalStands, hunterClearance } from '../map/micro/portals.ts';
import { createAccessMask, travelClear } from '../map/micro/geometry.ts';
import { applyClearConstraints, clearFootprint } from '../map/kernel/margins.ts';
import { rect } from '../shared/shape.ts';

const cells = (x, y, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const base = () => ({ cellSize: 40, cells: cells(0, 0, 8, 6), portals: [
  { id: 'west', axis: 'v', x: 0, y: 2, length: 2 }, { id: 'east', axis: 'v', x: 8, y: 2, length: 2 },
] });
function proof(input, result) {
  assert.equal(result.valid, true, result.errors.join('; '));
  const mask = createAccessMask(input), radius = hunterClearance(input.cellSize);
  for (const { points } of portalStands(input)) for (const p of points) assert.ok(travelClear(mask, input.blockers, p, p, radius));
  for (const join of result.joins) {
    assert.ok(join.points);
    assert.deepEqual(join.points[0], join.from);
    assert.deepEqual(join.points.at(-1), join.to);
    for (let i = 1; i < join.points.length; i++) assert.ok(travelClear(mask, input.blockers, join.points[i - 1], join.points[i], radius));
  }
}

test('optional fallback independently discovers off-lattice routes and sweeps seam connectors at several scales', () => {
  for (const scale of [0.5, 1, 2, 4]) {
    const input = { ...base(), cellSize: 40 * scale,
      // 76-unit opening: the radius-37 centre must cross at y=89..91,
      // between the grid's y=80 and y=100 samples. The wall spans all access.
      blockers: [rect(140 * scale, 0, 10 * scale, 52 * scale), rect(140 * scale, 128 * scale, 10 * scale, 112 * scale)] };
    const grid = validatePortalReach(input);
    assert.deepEqual(grid, validatePortalReach(input, { search: 'grid' }));
    assert.equal(grid.valid, false);
    assert.equal(grid.meshBuilds, 0);
    const thorough = validatePortalReach(input, { search: 'thorough' });
    proof(input, thorough);
    assert.equal(thorough.meshBuilds, 1);
    const path = thorough.joins.find(j => j.search === 'mesh').points;
    assert.ok(path.length > 3);
    // Original stands lie outside the conservatively eroded mesh. Their leads
    // are retained, including at the near-corner ends of the hand-built strips.
    assert.notDeepEqual(path[0], path[1]);
    assert.notDeepEqual(path.at(-1), path.at(-2));
    assert.deepEqual(validatePortalReach(input, { search: 'thorough' }), thorough);
  }
});

test('fallback joins every long-portal stand and reuses one mesh for multiple misses', () => {
  const input = { ...base(), portals: [{ id: 'west', axis: 'v', x: 0, y: 0, length: 6 }, base().portals[1]],
    // Both adjacent stand discs miss this post, but the straight capsule hits it.
    // A small leftward detour fits the known-clear strip; no grid sample fits it.
    blockers: [rect(36.7, 46, 0.1, 0.1)] };
  assert.match(validatePortalReach(input).errors[0], /Portal west is divided/);
  const result = validatePortalReach(input, { search: 'thorough' });
  proof(input, result);
  const stands = portalStands(input);
  assert.equal(result.joins.length, stands.reduce((n, s) => n + s.points.length - 1, 0) + 1);
  assert.ok(result.joins.filter(j => j.search === 'mesh').length >= 2);
  assert.equal(result.meshBuilds, 1);
});

test('bounded regions retain mesh discovery at large positive and negative addresses', () => {
  for (const offset of [-1e12, 1e12]) {
    const original = base(), shift = offset * original.cellSize;
    const input = { ...original,
      cells: original.cells.map(c => ({ x: c.x + offset, y: c.y + offset })),
      portals: original.portals.map(p => ({ ...p, x: p.x + offset, y: p.y + offset })),
      blockers: [rect(shift + 140, shift, 10, 52), rect(shift + 140, shift + 128, 10, 112)] };
    const result = validatePortalReach(input, { search: 'thorough' });
    proof(input, result);
    assert.equal(result.meshBuilds, 1);
    assert.equal(result.joins.at(-1).search, 'mesh');
  }
});

test('unrelated far-away blockers do not consume mesh coordinate range', () => {
  const input = { ...base(), blockers: [rect(140, 0, 10, 52), rect(140, 128, 10, 112), rect(4e13, 4e13, 10, 10)] };
  const result = validatePortalReach(input, { search: 'thorough' });
  proof(input, result);
  assert.equal(result.meshBuilds, 1);
});

test('grid successes remain identical and true separating walls fail both searches', () => {
  for (const blockers of [[], [rect(140, 0, 40, 40), rect(140, 120, 40, 120)],
    [rect(140, 0, 40, 240)], [rect(0, 80, 0.5, 80)]]) {
    const input = { ...base(), blockers }, grid = validatePortalReach(input);
    const result = validatePortalReach(input, { search: 'thorough' });
    assert.equal(result.valid, grid.valid);
    assert.deepEqual(result.errors, grid.errors);
    assert.deepEqual(result.routes, grid.routes);
    if (grid.valid) {
      proof(input, result);
      assert.equal(result.meshBuilds, 0);
      if (blockers.length) assert.equal(result.joins.at(-1).search, 'grid', 'retain a sampled doorway detour');
    }
  }
});

test('thorough mode respects macro corner caps, hand-built margins and clipped access', () => {
  const owned = cells(1, 1, 6, 6), portals = [
    { id: 'north', axis: 'h', x: 1, y: 1, length: 6 }, { id: 'west', axis: 'v', x: 1, y: 1, length: 6 },
  ];
  const margins = applyClearConstraints(owned, clearFootprint(portals, cells(0, 0, 8, 8)));
  const input = { cellSize: 40, cells: owned, portals, ...margins, blockers: [rect(80, 80, 160, 160)] };
  proof(input, validatePortalReach(input, { search: 'thorough' }));
  // Without the northwest cap, the two radius-37 corridors cannot turn
  // around the missing cell. Search failure alone is not the obstruction proof.
  for (const clipped of [
    { ...input, clearCells: input.clearCells.filter(c => c.x !== 0 || c.y !== 0) },
    { cellSize: 40, cells: owned, portals, blockers: input.blockers },
    { cellSize: 40, cells: cells(0, 0, 4, 4), fillCells: [], clearCells: [], blockers: [], portals: [
      { id: 'north', axis: 'h', x: 0, y: 0, length: 2 }, { id: 'south', axis: 'h', x: 0, y: 4, length: 2 },
    ] },
  ]) assert.equal(validatePortalReach(clipped, { search: 'thorough' }).valid, false);
});

test('zero/one portal exemption and input checks also apply in thorough mode', () => {
  for (const portals of [[], [base().portals[0]], [{ ...base().portals[0], length: 1 }]]) {
    const input = { ...base(), portals, blockers: [rect(0, 0, 40, 240)] };
    const result = validatePortalReach(input, { search: 'thorough' });
    assert.equal(result.valid, true);
    assert.equal(result.meshBuilds, 0);
    assert.deepEqual(result.joins, []);
    assert.equal(validatePortalReach({ ...input, blockers: [rect(0, 0, -1, 1)] }, { search: 'thorough' }).valid, false);
  }
  assert.match(validatePortalReach({ ...base(), blockers: [] }, { search: 'other' }).errors[0], /Unknown portal search/);
});
