import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARY, generate } from '../map/chain.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { declaredGrid, layoutViolations, orientDesign } from '../map/macro/src/chain/declared-grid.ts';
import { resolution } from '../map/macro/src/chain/resolution.ts';
import { regions, portalViolations } from '../map/macro/src/chain/regions.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { diagnoseBuiltMap } from '../map/micro/diagnose.ts';
import { builtMapCollision, builtMapFrame } from '../map/micro/adapter.ts';
import { canOccupy, moveBody } from '../shared/movement.ts';

const PARAMS = { mode: 'playground', zoneWidth: 1, zoneHeight: 1,
  exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0, lootTierStep: 0 };
const CLEAR = ['clear-rubble-bank', 'clear-rubble-bend', 'clear-rubble-center'];
const tile = id => CHAIN_LIBRARY.tiles.find(design => design.id === id);

function layout(slots, library = CHAIN_LIBRARY, params = PARAMS) {
  return { seed: 'clear-tiles', params, library: libraryFingerprint(library),
    slots: slots.map(([col, row, design, orientation = 0]) => ({ col, row, design, orientation })), setPieces: [] };
}
const at = (grid, x, y) => grid.cells[y * grid.width + x];

test('game fill prefers varied ground and builds features instead of mostly plain fields', () => {
  const map = generate('fill-214-1');
  const owned = new Set(map.layout.setPieces.flatMap(piece => piece.slots.map(slot => `${slot.col},${slot.row}`)));
  const fill = map.layout.slots.filter(slot => !owned.has(`${slot.col},${slot.row}`));
  const fields = fill.filter(slot => slot.design === 'field').length;
  assert.ok(fields < fill.length / 2, `${fields}/${fill.length} fill slots are plain fields`);
  for (const id of CLEAR.filter(id => tile(id).weight > 0)) assert.ok(fill.some(slot => slot.design === id), `${id} occurs in the fill`);
  assert.equal(tile('clear-rubble-center').weight, 0, 'the centered island is placed within an authored courtyard');
  assert.ok(map.results.some(result => result.brief.type === 'hut' && result.manifest.structures), 'fill retains a built house');
  assert.ok(map.results.some(result => result.brief.type === 'rubble' && result.elements.length), 'rubble builds physical features');
});

test('authored clear tiles leave their unpainted cells deferred in every orientation', () => {
  for (const id of CLEAR) {
    const design = tile(id);
    assert.ok(design, id);
    assert.deepEqual(design.orientations, [0, 90, 180, 270]);
    assert.ok(Object.values(design.segments).every(segment => segment.adjacency === undefined), `${id} does not ask its neighbours for a class`);
    for (const orientation of design.orientations) {
      const placed = layout([[2, 2, id, orientation]]);
      const grid = declaredGrid(placed, CHAIN_LIBRARY);
      const oriented = orientDesign(design, orientation);
      assert.deepEqual(layoutViolations(grid), [], `${id}@${orientation}`);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++)
        assert.equal(at(grid, 12 + x, 12 + y), oriented.cells[y * 6 + x], `${id}@${orientation} ${x},${y}`);
      assert.equal(oriented.cells.filter(cell => cell === 'any').length,
        id.endsWith('bank') ? 18 : id.endsWith('bend') ? 9 : 20);
      const resolved = resolution(placed, CHAIN_LIBRARY);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++)
        assert.equal(at(resolved, 12 + x, 12 + y), oriented.cells[y * 6 + x] === 'any' ? 'open' : 'rubble',
          `${id}@${orientation} ${x},${y}`);
      const found = regions(resolved, placed.seed);
      assert.deepEqual(portalViolations(found), [], `${id}@${orientation}`);
      assert.ok(found.portals.some(portal => portal.length === (id.endsWith('center') ? 4 : 3)),
        `${id}@${orientation} keeps its authored opening`);
    }
  }
});

test('a neighbouring adjacency ask settles an authored any cell, and conflicting corner asks fail', () => {
  // The bank's top-right cell is `any`. Its east and north neighbours may each ask it for a class.
  const ask = (id, segments) => ({ ...tile('field'), id, segments: { ...tile('field').segments, ...segments } });
  const library = { ...CHAIN_LIBRARY, tiles: [...CHAIN_LIBRARY.tiles,
    ask('asks-rubble-west', { 'v:0,0': { adjacency: 'rubble', passability: 'any' } }),
    ask('asks-cover-south', { 'h:6,5': { adjacency: 'cover', passability: 'any' } })] };
  const bank = [2, 2, 'clear-rubble-bank'];
  const east = [3, 2, 'asks-rubble-west'];
  const north = [2, 1, 'asks-cover-south'];
  const onlyEast = layout([bank, east], library);
  const declared = declaredGrid(onlyEast, library);
  assert.equal(at(declared, 17, 12), 'any');
  assert.deepEqual(layoutViolations(declared), []);
  assert.equal(at(resolution(onlyEast, library), 17, 12), 'rubble');
  assert.equal(at(resolution(onlyEast, library), 16, 12), 'open', 'an unasked any cell still defaults to open');

  const corner = layout([bank, east, north], library);
  assert.equal(at(declaredGrid(corner, library), 17, 12), 'any');
  assert.match(layoutViolations(declaredGrid(corner, library)).join('; '), /any cell 17,12 is asked for cover and rubble/);
  assert.throws(() => resolution(corner, library), /any cell 17,12 is asked for rubble and cover|any cell 17,12 is asked for cover and rubble/);
});

test('rotated bank and bend merge into an irregular rubble region and build reachable portals', () => {
  const placed = layout([[1, 1, 'field'], [2, 1, 'field'],
    [1, 2, 'clear-rubble-bank', 180], [2, 2, 'clear-rubble-bend', 0]]);
  const grid = declaredGrid(placed, CHAIN_LIBRARY);
  assert.deepEqual(layoutViolations(grid), []);
  const resolved = resolution(placed, CHAIN_LIBRARY);
  const found = regions(resolved, placed.seed);
  assert.deepEqual(portalViolations(found), []);
  const rubble = found.regions.filter(region => region.class === 'rubble');
  assert.equal(rubble.length, 1, 'the painted rubble joins across the tile seam');
  assert.equal(rubble[0].cells.length, 45);
  assert.ok(found.regions.some(region => region.class === 'open'));
  const inputs = briefs(placed, resolved, found, chainZones(PARAMS), CHAIN_LIBRARY, 48);
  assert.ok(inputs.some(input => input.type === 'rubble' && input.portals.length >= 2));
  assert.ok(inputs.some(input => input.type === 'open' && input.portals.length >= 2));
  for (const input of inputs) {
    const built = buildRegion(input);
    if (input.type === 'rubble') assert.ok(built.elements.length, 'merged rubble paints physical geometry');
    const blockers = built.elements.flatMap(element => elementShapes(element));
    assert.deepEqual(validatePortalReach({ ...input, blockers }).errors, [], `${input.type} ${input.id}`);
  }
});

test('centered rubble leaves a clear ring that carries hunter movement through a built cover patch', () => {
  const design = tile('clear-rubble-center');
  const court = CHAIN_LIBRARY.setPieces.find(piece => piece.id === 'rubble-court');
  assert.deepEqual(court.tiles, Array.from({ length: 9 }, (_, i) => ({ dx: i % 3, dy: Math.floor(i / 3),
    tileSetId: i === 4 ? 'clear-rubble-centers' : 'cover-grounds' })), 'the shipped courtyard supplies the tested surrounding cover');
  const params = { ...PARAMS, zoneWidth: 2, zoneHeight: 2 };
  assert.deepEqual(design.cells, ['......', '.rrrr.', '.rrrr.', '.rrrr.', '.rrrr.', '......']);
  const perimeter = Array.from({ length: 6 }, (_, i) => [`h:0,${i}`, `h:6,${i}`, `v:0,${i}`, `v:6,${i}`]).flat();
  assert.deepEqual(Object.keys(design.segments).sort(), [...perimeter, ...[1, 2, 3, 4].map(i => `h:1,${i}`)].sort());
  assert.ok(Object.values(design.segments).every(segment => segment.passability === 'passable'));
  assert.ok(Object.values(design.segments).every(segment => segment.adjacency === undefined));
  for (const orientation of design.orientations) {
    const slots = [];
    for (let row = 3; row <= 5; row++) for (let col = 3; col <= 5; col++)
      slots.push([col, row, col === 4 && row === 4 ? design.id : 'cover-ground', col === 4 && row === 4 ? orientation : 0]);
    const placed = layout(slots, CHAIN_LIBRARY, params), grid = declaredGrid(placed, CHAIN_LIBRARY);
    assert.deepEqual(layoutViolations(grid), [], `${orientation} adjacency`);
    const resolved = resolution(placed, CHAIN_LIBRARY), found = regions(resolved, placed.seed);
    assert.deepEqual(portalViolations(found), [], `${orientation} portal width`);
    const inputs = briefs(placed, resolved, found, chainZones(params), CHAIN_LIBRARY, 40);
    const rubble = inputs.find(input => input.type === 'rubble');
    const open = inputs.find(input => input.type === 'open');
    assert.equal(rubble.cells.length, 16, `${orientation} centered rubble ownership`);
    assert.equal(rubble.fillCells.length, 12, `${orientation} rubble keeps its clear margin`);
    assert.equal(open.cells.length, 20, `${orientation} open ring ownership`);
    const results = inputs.map(input => buildRegion(input));
    assert.ok(results.find(result => result.brief.type === 'rubble').manifest.obstacles >= 2,
      `${orientation} places physical debris inside the ring`);
    const composed = composeRegions(results);
    assert.deepEqual(diagnoseBuiltMap(composed), [], `${orientation} composed portal promises`);

    // The route uses all explicitly assembled cells and geometry; movement then checks
    // the same hunter clearance through the arena collision used by a live match.
    const stands = portalStands(open).flatMap(portal => portal.points);
    assert.ok(stands.length >= 2, `${orientation} has original open-region portal stands`);
    const from = stands[0], to = stands.at(-1), radius = hunterClearance(40);
    assert.notDeepEqual(from, to, `${orientation} traverses distinct portal stands`);
    assert.equal(radius, 37);
    const mask = createRegionMask({ cellSize: 40, cells: inputs.flatMap(input => input.cells) });
    const blockers = results.flatMap(result => result.elements.flatMap(elementShapes));
    const route = findRegionRoute(mask, blockers, from, to, radius);
    assert.ok(route, `${orientation} assembled hunter route reaches the original portal stands`);
    assert.ok(route.length >= 2, `${orientation} route spans the clear ring`);
    const collision = builtMapCollision(composed), { origin } = builtMapFrame(composed);
    const mover = { x: from.x + origin.x, y: from.y + origin.y };
    assert.ok(canOccupy(collision, mover.x, mover.y, radius), `${orientation} first portal stand fits`);
    for (const goal of route.slice(1)) {
      let steps = 1000;
      while (Math.hypot(goal.x + origin.x - mover.x, goal.y + origin.y - mover.y) > .01 && steps-- > 0) {
        const dx = goal.x + origin.x - mover.x, dy = goal.y + origin.y - mover.y, distance = Math.hypot(dx, dy);
        moveBody(collision, mover, { x: dx / distance, y: dy / distance }, radius, Math.min(4, distance));
        assert.ok(canOccupy(collision, mover.x, mover.y, radius), `${orientation} body stays in the built map`);
      }
      assert.ok(steps > 0, `${orientation} actual movement reaches the portal stand`);
    }
    assert.ok(Math.hypot(to.x + origin.x - mover.x, to.y + origin.y - mover.y) <= .01,
      `${orientation} mover arrives at the destination portal stand`);
  }
});
