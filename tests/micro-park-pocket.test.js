import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readMap } from '../map/tools/core.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { createBuilderCanvas } from '../map/micro/canvas.ts';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesShareArea, travelClear } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { portalApproaches } from '../map/micro/strategies/scatter.ts';
import { PARK_POCKET_LIMITS, siteParkPocket } from '../map/micro/strategies/park-pocket.ts';
import { cellsOf } from './helpers/cells.js';
import { rect } from '../shared/shape.ts';

const savedResults = size => readMap(JSON.parse(gunzipSync(readFileSync(new URL(`../docs/reports/issue-688/size-${size}-1.json.gz`, import.meta.url))))).results;
const saved = size => savedResults(size).filter(r => r.brief.type === 'park').map(r => r.brief);
const shapes = result => result.elements.flatMap(e => elementShapes(e));
const pocket = result => result.elements.filter(e => e.label === 'park-pocket');
const tryPocket = brief => {
  // Park's own canvas: fixed portal approaches and a live cord witness (#750).
  const canvas = createProspectiveParcels(brief, { fixedAccess: portalApproaches(brief, 'Park') }).coordinator;
  const result = siteParkPocket(brief, canvas);
  assert.ok(result.candidates <= PARK_POCKET_LIMITS.candidates);
  assert.ok(result.routes <= PARK_POCKET_LIMITS.routes);
  return { result, canvas };
};
const synthetic = (cells, portals = []) => ({ id: 'pocket-test', seed: 1, type: 'park', cellSize: 40, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0, cells }], portals });

test('saved park pocket retains fill, portal and hunter access after scatter', () => {
  const brief = saved(24).find(b => b.id === 'park@372,150');
  assert.ok(brief);
  const { result: sited, canvas } = tryPocket(brief);
  assert.ok(sited.envelope);
  assert.equal(canvas.elements.length, 1);
  const result = buildRegion(brief), pieces = pocket(result);
  assert.equal(pieces.length, 1);
  assert.equal(result.manifest.pockets, 1);
  assert.equal(result.manifest.fronts, result.elements.filter(e => e.label.startsWith('park-front-')).length);
  for (const element of result.elements.filter(e => e.label !== 'park-pocket'))
    assert.ok(elementShapes(element, true).every(shape => !shapesShareArea(shape, sited.envelope)),
      'scatter leaves the whole pocket and apron free, not only the entrance witness');
  const blockers = shapes(result), mask = createAccessMask(brief), radius = hunterClearance(brief.cellSize);
  assert.deepEqual(validateFillConstraints(brief, blockers), []);
  assert.deepEqual(validatePortalReach({ ...brief, blockers }, { search: 'thorough' }).errors, []);
  const e = pieces[0], size = brief.cellSize;
  const target = { x: e.x + 3 * size, y: e.y + 7 * size };
  const stands = portalStands(brief).flatMap(p => p.points);
  assert.ok(stands.some(start => findRegionRoute(mask, blockers, start, target, radius)), 'a portal can reach the pocket interior');
  assert.ok(travelClear(mask, blockers, { x: e.x + 12 * size, y: e.y + 7 * size },
    { x: e.x + 15 * size, y: e.y + 7 * size }, radius), 'the mouth stays clear after scatter');
  // Cell order and hedges off are checked on the smaller saved park below, which also builds a pocket:
  // each rebuild of this 2232-cell brief cost about 2 s (#807).
});

test('pocket siting is bounded and leaves no partial placement on unsuitable fills', () => {
  const noPortal = synthetic(cellsOf(24, 24));
  const fragmented = synthetic(cellsOf(40, 40, (x, y) => x % 8 < 6 || y === 0),
    [{ id: 'north', axis: 'h', x: 0, y: 0, length: 3 }]);
  for (const brief of [noPortal, fragmented]) {
    const { result, canvas } = tryPocket(brief);
    assert.equal(result.envelope, null, brief.id);
    assert.deepEqual(canvas.elements, []);
    assert.equal(pocket(buildRegion(brief)).length, 0);
  }
});

test('a pocket the frozen routes refused fits once cords may bend round it (#750), in any cell order, and not with hedges off', () => {
  const original = savedResults(12).find(r => r.brief.id === 'park@144,36'), small = original.brief;
  assert.equal(small.cells.length, 936);
  // Its routes between portals left no pocket envelope and no lattice slot clear.
  assert.deepEqual(original.elements, []);
  const rebuilt = buildRegion(small);
  assert.equal(pocket(rebuilt).length, 1);
  assert.equal(rebuilt.manifest.pockets, 1);
  assert.deepEqual(validatePortalReach({ ...small, blockers: shapes(rebuilt) }, { search: 'thorough' }).errors, []);
  assert.deepEqual(buildRegion({ ...small, cells: [...small.cells].reverse() }).elements, rebuilt.elements);
  const noHedges = buildRegion({ ...small, parameters: { ...small.parameters, hedges: 0 } });
  assert.equal(pocket(noHedges).length, 0);
  assert.ok(!noHedges.manifest.pockets);
});

test('an unreachable pocket exhausts the route budget without a partial canvas claim', () => {
  const cells = [...cellsOf(20, 20), ...cellsOf(20, 1).map(c => ({ x: c.x + 20, y: 10 })),
    ...cellsOf(24, 24).map(c => ({ x: c.x + 40, y: c.y }))];
  const brief = synthetic(cells, [{ id: 'north', axis: 'h', x: 2, y: 0, length: 3 }]);
  // The near room is authored clear intent; only the far room can hold the piece.
  // Its connecting neck is cell-connected but too narrow for the SDK hunter.
  const canvas = createBuilderCanvas(brief, [rect(0, 0, 20 * brief.cellSize, 20 * brief.cellSize)]);
  const result = siteParkPocket(brief, canvas);
  assert.equal(result.envelope, null);
  assert.equal(result.routes, PARK_POCKET_LIMITS.routes);
  assert.ok(result.candidates <= PARK_POCKET_LIMITS.candidates);
  assert.deepEqual(canvas.elements, []);
  assert.deepEqual(canvas.addressed.unaddressedComponents().flat().length, canvas.fill.cells.length);
});
