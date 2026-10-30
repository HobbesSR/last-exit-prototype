import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readMap } from '../map/tools/core.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { createBuilderCanvas } from '../map/micro/canvas.ts';
import { createAccessMask, elementShapes, findRegionRoute, travelClear } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { PARK_POCKET_LIMITS, siteParkPocket } from '../map/micro/strategies/park-pocket.ts';
import { cellsOf } from './helpers/cells.js';

const saved = size => readMap(JSON.parse(gunzipSync(readFileSync(new URL(`../docs/reports/issue-688/size-${size}-1.json.gz`, import.meta.url))))).results
  .filter(r => r.brief.type === 'park').map(r => r.brief);
const shapes = result => result.elements.flatMap(e => elementShapes(e));
const pocket = result => result.elements.filter(e => e.label === 'park-pocket');
const tryPocket = brief => {
  const protectedShapes = protectedRoutes(brief, 'Park', brief.portals.length <= 32 ? 'root' : 'nearby');
  const canvas = createBuilderCanvas(brief, protectedShapes);
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
  assert.equal(result.manifest.hedges, result.elements.filter(e => e.label.startsWith('park-hedge-')).length);
  const blockers = shapes(result), mask = createAccessMask(brief), radius = hunterClearance(brief.cellSize);
  assert.deepEqual(validateFillConstraints(brief, blockers), []);
  assert.deepEqual(validatePortalReach({ ...brief, blockers }, { search: 'thorough' }).errors, []);
  const e = pieces[0], size = brief.cellSize;
  const target = { x: e.x + 3 * size, y: e.y + 7 * size };
  const stands = portalStands(brief).flatMap(p => p.points);
  assert.ok(stands.some(start => findRegionRoute(mask, blockers, start, target, radius)), 'a portal can reach the pocket interior');
  assert.ok(travelClear(mask, blockers, { x: e.x + 12 * size, y: e.y + 7 * size },
    { x: e.x + 15 * size, y: e.y + 7 * size }, radius), 'the mouth stays clear after scatter');
  const reordered = { ...brief, cells: [...brief.cells].reverse() };
  assert.deepEqual(buildRegion(reordered).elements, result.elements);
  const noHedges = buildRegion({ ...brief, parameters: { ...brief.parameters, hedges: 0 } });
  assert.equal(pocket(noHedges).length, 0);
  assert.ok(!noHedges.manifest.pockets);
});

test('pocket siting is bounded and leaves no partial placement on unsuitable fills', () => {
  const small = saved(12).find(b => b.id === 'park@144,36');
  assert.equal(small.cells.length, 936, 'a large real park can still have no admissible pocket');
  const noPortal = synthetic(cellsOf(24, 24));
  const fragmented = synthetic(cellsOf(40, 40, (x, y) => x % 8 < 6 || y === 0),
    [{ id: 'north', axis: 'h', x: 0, y: 0, length: 3 }]);
  for (const brief of [small, noPortal, fragmented]) {
    const { result, canvas } = tryPocket(brief);
    assert.equal(result.envelope, null, brief.id);
    assert.deepEqual(canvas.elements, []);
    assert.equal(pocket(buildRegion(brief)).length, 0);
  }
  const original = readMap(JSON.parse(gunzipSync(readFileSync(new URL('../docs/reports/issue-688/size-12-1.json.gz', import.meta.url)))))
    .results.find(r => r.brief.id === small.id);
  assert.deepEqual(buildRegion(small), original, 'the large real no-fit result remains exact');
});
