import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARY, chainParams } from '../map/chain.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { resolution } from '../map/macro/src/chain/resolution.ts';
import { regions } from '../map/macro/src/chain/regions.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, travelClear, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../map/micro/adapter.ts';
import { moveBody, canOccupy } from '../shared/movement.ts';
import { rect } from '../shared/shape.ts';

test('clear opposite portal approaches do not excuse a separating wall', () => {
  const region = {
    cellSize: 40,
    cells: Array.from({ length: 48 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8) })),
    portals: [
      { id: 'west', axis: 'v', x: 0, y: 2, length: 2 },
      { id: 'east', axis: 'v', x: 8, y: 2, length: 2 },
    ],
  };
  assert.equal(validatePortalReach({ ...region, blockers: [] }).valid, true);
  const divided = validatePortalReach({ ...region, blockers: [rect(140, 0, 40, 240)] });
  assert.equal(divided.valid, false);
  assert.deepEqual(divided.errors, ['Portal east is unreachable from portal west.']);
});

// #214: distinguish a region-local clearance promise from actual assembled movement.
// This is a diagnostic witness, not permission for a builder to rely on unknown neighbours.
test('region-local hunter checks can reject clear movement through the assembled map', () => {
  const library = structuredClone(CHAIN_LIBRARY), field = library.tiles.find(tile => tile.id === 'field');
  library.tiles.push({
    id: 'centered-rubble-probe', defaultCellClass: 'any',
    cells: ['......', '.rrrr.', '.rrrr.', '.rrrr.', '.rrrr.', '......'],
    legend: { r: 'rubble' }, orientations: [0], weight: 0,
    segments: { ...field.segments, 'h:1,2': { passability: 'passable' }, 'h:1,3': { passability: 'passable' } },
  });
  const params = chainParams({ mode: 'playground', zoneWidth: 2, zoneHeight: 2 }), slots = [];
  for (let row = 3; row <= 5; row++) for (let col = 3; col <= 5; col++)
    slots.push({ col, row, design: col === 4 && row === 4 ? 'centered-rubble-probe' : 'cover-ground', orientation: 0 });
  const layout = { seed: 'centered-access-probe', params, library: libraryFingerprint(library), slots, setPieces: [] };
  const resolved = resolution(layout, library), found = regions(resolved, layout.seed);
  const inputs = briefs(layout, resolved, found, chainZones(params), library, 40);
  const built = inputs.map(input => buildRegion(input)), open = built.find(region => region.brief.type === 'open');
  assert.equal(open.brief.cells.length, 20, 'the centered feature leaves a one-cell open ring');
  assert.ok(built.some(region => region.brief.type === 'rubble' && region.elements.length), 'the feature contains real debris');
  const ownMask = createRegionMask(open.brief);
  const allMask = createRegionMask({ cells: inputs.flatMap(input => input.cells), cellSize: 40 });
  const blockers = built.flatMap(region => region.elements.flatMap(elementShapes));
  const points = portalStands(open.brief).flatMap(stand => stand.points), radius = hunterClearance(40);
  assert.ok(points.length > 1);
  assert.ok(validatePortalReach({ ...open.brief, blockers: [] }).errors.length);
  for (const point of points) {
    assert.equal(travelClear(ownMask, [], point, point, radius), false, 'even an empty ring rejects whole-body containment');
    assert.ok(travelClear(allMask, blockers, point, point, radius), 'the assembled geometry admits that same body');
  }

  const root = points[0], composed = composeRegions(built), collision = builtMapCollision(composed);
  const { origin } = builtMapFrame(composed);
  for (const target of points) {
    const route = findRegionRoute(allMask, blockers, root, target, radius);
    assert.ok(route, 'assembled swept-disc search reaches each locally rejected stand');
    const mover = { x: root.x + origin.x, y: root.y + origin.y };
    for (const goal of route.slice(1)) {
      let steps = 1000;
      while (Math.hypot(goal.x + origin.x - mover.x, goal.y + origin.y - mover.y) > .01 && steps-- > 0) {
        const dx = goal.x + origin.x - mover.x, dy = goal.y + origin.y - mover.y, length = Math.hypot(dx, dy);
        moveBody(collision, mover, { x: dx / length, y: dy / length }, radius, Math.min(4, length));
        assert.ok(canOccupy(collision, mover.x, mover.y, radius));
      }
      assert.ok(steps > 0, 'actual movement reaches the target using the same hunter clearance');
    }
  }
});
