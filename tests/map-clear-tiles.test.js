import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARY, generate } from '../map/chain.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { declaredGrid, layoutViolations, orientDesign } from '../map/macro/src/chain/declared-grid.ts';
import { resolution } from '../map/macro/src/chain/resolution.ts';
import { regions, portalViolations } from '../map/macro/src/chain/regions.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const PARAMS = { mode: 'playground', zoneWidth: 1, zoneHeight: 1,
  exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0, lootTierStep: 0 };
const CLEAR = ['clear-rubble-bank', 'clear-rubble-bend'];
const tile = id => CHAIN_LIBRARY.tiles.find(design => design.id === id);

function layout(slots, library = CHAIN_LIBRARY) {
  return { seed: 'clear-tiles', params: PARAMS, library: libraryFingerprint(library),
    slots: slots.map(([col, row, design, orientation = 0]) => ({ col, row, design, orientation })), setPieces: [] };
}
const at = (grid, x, y) => grid.cells[y * grid.width + x];

test('game fill prefers varied ground and builds features instead of mostly plain fields', () => {
  const map = generate('fill-214-1');
  const owned = new Set(map.layout.setPieces.flatMap(piece => piece.slots.map(slot => `${slot.col},${slot.row}`)));
  const fill = map.layout.slots.filter(slot => !owned.has(`${slot.col},${slot.row}`));
  const fields = fill.filter(slot => slot.design === 'field').length;
  assert.ok(fields < fill.length / 2, `${fields}/${fill.length} fill slots are plain fields`);
  for (const id of CLEAR) assert.ok(fill.some(slot => slot.design === id), `${id} occurs in the fill`);
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
      assert.equal(oriented.cells.filter(cell => cell === 'any').length, id.endsWith('bank') ? 18 : 9);
      const resolved = resolution(placed, CHAIN_LIBRARY);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++)
        assert.equal(at(resolved, 12 + x, 12 + y), oriented.cells[y * 6 + x] === 'any' ? 'open' : 'rubble',
          `${id}@${orientation} ${x},${y}`);
      const found = regions(resolved, placed.seed);
      assert.deepEqual(portalViolations(found), [], `${id}@${orientation}`);
      assert.ok(found.portals.some(portal => portal.length === 3), `${id}@${orientation} keeps its authored opening`);
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
