import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFootprint, applyClearConstraints, withClearMargins } from '../map/kernel/margins.ts';
import { createAccessMask, createFillMask, travelClear, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { inheritBriefMargins, validateFillConstraints } from '../map/micro/margins.ts';
import { REGION_TYPES, buildRegion, briefErrors } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { rect } from '../shared/shape.ts';
import { moveBody, canOccupy } from '../shared/movement.ts';

const cells = (x0, y0, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x0 + i % w, y: y0 + Math.floor(i / w) }));
const brief = (owned, portals, playable = owned) => ({ id: 'test', seed: 1, type: 'block', cellSize: 40,
  cells: owned, portals, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }],
  ...applyClearConstraints(owned, clearFootprint(portals, playable)) });

test('shared one-cell approaches admit swept hunter routes and actual movement at the same radius', () => {
  const owned = cells(0, 1, 8, 3), playable = cells(0, 0, 8, 5);
  const input = brief(owned, [{ id: 'left', axis: 'h', x: 1, y: 1, length: 2 },
    { id: 'right', axis: 'h', x: 5, y: 1, length: 2 }], playable);
  // A continuous guaranteed seam gives two owners a one-cell clearance strip each.
  Object.assign(input, applyClearConstraints(owned, clearFootprint([{ axis: 'h', x: 0, y: 1, length: 8 }], playable)));
  const blockers = [rect(0, 80, 320, 80)];
  const checked = validatePortalReach({ ...input, blockers });
  assert.deepEqual(checked.errors, []);
  const radius = hunterClearance(40), mask = createAccessMask(input);
  assert.equal(radius, 37);
  assert.ok(createFillMask(input).contains(blockers[0]));
  const [a, b] = portalStands(input).map(p => p.points[0]);
  assert.equal(a.y, 40, 'stands use the original seam, not the old full-body inward inset');
  const route = findRegionRoute(mask, blockers, a, b, radius);
  assert.ok(route);
  const collision = { width: 320, height: 200, gates: [], obstacles: [{ id: 'wall', kind: 'ruin-wall', ...blockers[0] }],
    playableArea: { cellSize: 40, rows: Array.from({ length: 5 }, (_, y) => ({ y, runs: [[0, 8]] })) } };
  const mover = { ...a };
  for (const goal of route.slice(1)) {
    let remaining = 200;
    while (Math.hypot(goal.x - mover.x, goal.y - mover.y) > .01 && remaining-- > 0) {
      const dx = goal.x - mover.x, dy = goal.y - mover.y, distance = Math.hypot(dx, dy);
      moveBody(collision, mover, { x: dx / distance, y: dy / distance }, radius, Math.min(4, distance));
      assert.ok(canOccupy(collision, mover.x, mover.y, radius));
    }
    assert.ok(remaining > 0);
  }
});

test('clear opposite portals still reject a full-height separating wall', () => {
  const input = brief(cells(1, 0, 8, 6), [
    { id: 'west', axis: 'v', x: 1, y: 2, length: 2 }, { id: 'east', axis: 'v', x: 9, y: 2, length: 2 },
  ], cells(0, 0, 10, 6));
  assert.deepEqual(validatePortalReach({ ...input, blockers: [] }).errors, []);
  assert.deepEqual(validatePortalReach({ ...input, blockers: [rect(180, 0, 40, 240)] }).errors,
    ['Portal east is unreachable from portal west.']);
});

test('endpoint caps admit a corner turn, side strips alone leave a real pinch', () => {
  const owned = cells(1, 1, 6, 6), playable = cells(0, 0, 8, 8);
  const input = brief(owned, [{ id: 'north', axis: 'h', x: 1, y: 1, length: 6 },
    { id: 'west', axis: 'v', x: 1, y: 1, length: 6 }], playable);
  const blockers = [rect(80, 80, 160, 160)], radius = hunterClearance(40);
  const a = { x: 160, y: 40 }, b = { x: 40, y: 160 };
  const mask = createAccessMask(input);
  assert.ok(findRegionRoute(mask, blockers, a, b, radius));
  const missing = createAccessMask({ ...input, clearCells: input.clearCells.filter(c => c.x !== 0 || c.y !== 0) });
  assert.equal(findRegionRoute(missing, blockers, a, b, radius), null);
  assert.ok(travelClear(mask, blockers, a, { x: 40, y: 40 }, radius));
  assert.ok(travelClear(mask, blockers, { x: 40, y: 40 }, b, radius));
});

test('map clipping supplies no invented clearance outside the playable cells', () => {
  const owned = cells(0, 0, 4, 4);
  const input = brief(owned, [{ id: 'north', axis: 'h', x: 0, y: 0, length: 2 },
    { id: 'south', axis: 'h', x: 0, y: 4, length: 2 }]);
  assert.ok(validatePortalReach({ ...input, blockers: [] }).errors.some(e => /obstructed/.test(e)));
  assert.equal(createAccessMask(input).has(0, -1), false);
});

test('a brief without margins derives them from its own portals, with no end caps past the boundary', () => {
  const owned = cells(0, 0, 6, 4), portals = [{ id: 'west', axis: 'v', x: 0, y: 1, length: 2 }];
  const input = { id: 'hand', seed: 1, type: 'open', cellSize: 40, cells: owned, portals, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }] };
  const derived = withClearMargins(input);
  const key = c => `${c.x},${c.y}`;
  // The strip across the portal and the owned column beside it; caps across the boundary are left out.
  assert.deepEqual(derived.clearCells.map(key).sort(), ['-1,1', '-1,2', '0,0', '0,1', '0,2', '0,3'].sort());
  assert.ok(derived.fillCells.every(c => c.x > 0));
  assert.equal(withClearMargins(derived), derived, 'margins already carried are kept');
  assert.deepEqual(briefErrors(derived), []);
  // Margins a macro brief carries are never re-derived or inset again.
  const carried = { ...input, fillCells: owned, clearCells: [] };
  assert.equal(withClearMargins(carried), carried);
  assert.deepEqual(createFillMask(input).cells.map(key), derived.fillCells.map(key));
});

test('malformed or oversized runs on a bare brief are refused before any margin is derived', { timeout: 2000 }, () => {
  const owned = cells(0, 0, 4, 4), base = { cells: owned, cellSize: 40, blockers: [] };
  for (const length of [1e9, Infinity, 0, 1.5]) {
    const portal = { id: 'oversized', axis: 'v', x: 0, y: 0, length };
    assert.deepEqual(validatePortalReach({ ...base, portals: [portal] }).errors, ['Portal oversized is not a run.'], String(length));
    assert.throws(() => createAccessMask({ ...base, portals: [portal] }), /not a run/);
    assert.throws(() => createFillMask({ ...base, portals: [portal] }), /not a run/);
  }
  assert.throws(() => createFillMask({ ...base, portals: [], internalGuaranteed: [{ axis: 'h', x: 0, y: 1, length: 1e9 }] }), /bounded list of runs/);
  // The kernel holds no SDK limits; it refuses what isn't a run and clips the rest to the cells.
  assert.throws(() => withClearMargins({ cells: owned, portals: [{ id: 'p', axis: 'v', x: 0, y: 0, length: Infinity }] }), /whole length/);
  const clipped = withClearMargins({ cells: owned, portals: [{ id: 'p', axis: 'v', x: 0, y: 0, length: 1e9 }] });
  assert.deepEqual(clipped.fillCells.map(c => c.x).filter(x => x === 0), []);
});

test('block child handoffs retain original ownership and apply inherited and new margins once', () => {
  const owned = cells(1, 1, 48, 36), playable = cells(0, 0, 50, 38);
  const input = brief(owned, [{ id: 'west', axis: 'v', x: 1, y: 10, length: 4 },
    { id: 'east', axis: 'v', x: 49, y: 20, length: 4 }], playable);
  input.internalGuaranteed = [{ axis: 'h', x: 1, y: 18, length: 48 }];
  Object.assign(input, applyClearConstraints(owned, clearFootprint(input.internalGuaranteed, playable), input.clearCells));
  const plan = planBlock(input);
  assert.ok(plan.lots.length);
  const children = [...plan.lots, plan.alleys];
  const all = children.flatMap(c => c.cells.map(p => `${p.x},${p.y}`));
  assert.equal(all.length, owned.length);
  assert.equal(new Set(all).size, owned.length);
  const excluded = new Set(owned.filter(c => !input.fillCells.some(p => p.x === c.x && p.y === c.y)).map(c => `${c.x},${c.y}`));
  assert.ok(plan.lots.some(lot => lot.cells.some(c => excluded.has(`${c.x},${c.y}`))),
    'internal clear cells retain lot ownership instead of erasing eligible lots');
  assert.deepEqual(plan.alleys.portals.filter(p => input.portals.some(q => q.id === p.id)), input.portals);
  for (const child of children) {
    assert.deepEqual(applyClearConstraints(child.cells, [], child.clearCells),
      { fillCells: child.fillCells, clearCells: child.clearCells });
    assert.ok(child.fillCells.every(c => input.fillCells.some(p => p.x === c.x && p.y === c.y)));
  }
});

test('registered builders respect automatic fill exclusions even beside hints', () => {
  const owned = cells(1, 1, 24, 20), playable = cells(0, 0, 26, 22);
  const input = brief(owned, [{ id: 'west', axis: 'v', x: 1, y: 8, length: 3 },
    { id: 'east', axis: 'v', x: 25, y: 8, length: 3 }], playable);
  input.hints = [{ axis: 'h', x: 1, y: 1, length: 24 }];
  // Internal requirements also exclude cells, independent of external portal count.
  const internal = [{ axis: 'h', x: 1, y: 5, length: 24 }];
  Object.assign(input, applyClearConstraints(owned, clearFootprint(internal, playable), input.clearCells));
  input.internalGuaranteed = internal;
  for (const type of Object.keys(REGION_TYPES)) {
    const result = buildRegion({ ...input, type });
    const blockers = result.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validateFillConstraints(result.brief, blockers), [], type);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: result.elements.flatMap(elementShapes) }).errors, [], type);
    assert.equal(result.manifest.cells, owned.length, type);
  }
});

test('empty fill preserves core requests and original siting ownership', () => {
  const input = brief(cells(0, 0, 12, 12), []);
  input.fillCells = [];
  input.clearCells = input.cells;
  for (const [type, coreElements] of [['arrival', { spawn: 3 }], ['departure', { exit: 1, 'hunter-spawn': 1 }],
    ['charging', { charger: 1 }], ['transit', { warp: 1 }]]) {
    const result = buildRegion({ ...input, type, coreElements });
    assert.equal(result.elements.length, 0, type);
    assert.equal(result.coreElements.length, Object.values(coreElements).reduce((a, b) => a + b, 0), type);
    assert.equal(result.manifest.cells, 144);
  }
});

test('nested handoffs keep cleared cells owned and do not apply a second inset', () => {
  const parent = brief(cells(0, 0, 8, 6), []);
  const [child] = inheritBriefMargins(parent, [{ ...parent, id: 'child',
    portals: [{ id: 'new', axis: 'v', x: 0, y: 1, length: 3 }] }]);
  const [grandchild] = inheritBriefMargins(child, [{ ...child, id: 'grandchild' }]);
  assert.deepEqual(grandchild.fillCells, child.fillCells);
  assert.deepEqual(grandchild.clearCells, child.clearCells);
  assert.deepEqual(grandchild.cells, parent.cells);
  assert.deepEqual(grandchild.portals, child.portals);
  assert.deepEqual(validateFillConstraints(child, [rect(0, 40, 10, 10)]), ['Collision geometry leaves the allowed fill area.']);
  assert.ok(briefErrors({ ...child, fillCells: child.cells }).some(e => /available for filling/.test(e)));
});
