import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { rect } from '../shared/shape.ts';
import { brief, compoundBox, MASKS, SIZE } from './helpers/compound-fixtures.js';
import { cellsOf } from './helpers/cells.js';

function observed(input) {
  const traces = [];
  const result = buildRegion(input, undefined, trace => traces.push(trace));
  return { result, traces };
}

function spaceCenter(trace, space) {
  const xs = space.cells.map(c => c.x), ys = space.cells.map(c => c.y);
  return { x: trace.origin.x + (Math.min(...xs) + Math.max(...xs) + 1) * SIZE / 2,
    y: trace.origin.y + (Math.min(...ys) + Math.max(...ys) + 1) * SIZE / 2 };
}

function openingCenter(trace, opening) {
  const { axis, x, y } = opening.run;
  return { x: trace.origin.x + (x + (axis === 'h' ? opening.center : 0)) * SIZE,
    y: trace.origin.y + (y + (axis === 'v' ? opening.center : 0)) * SIZE };
}

test('a roomy compound composes a keep and court cover while retaining access', () => {
  const input = brief('court', 1, ...MASKS.field), { result, traces } = observed(input);
  const ring = traces.find(trace => trace.label === 'compound');
  const keep = traces.find(trace => trace.label === 'compound-keep');
  assert.ok(ring && keep, 'ring and keep are observed');
  assert.equal(result.elements.filter(e => e.label === 'compound-keep').length, 1);
  assert.ok(result.elements.some(e => e.label.startsWith('compound-court-cover-')), 'court has cover');
  const box = compoundBox(result), court = { x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 };
  const bands = [rect(court.x * SIZE, court.y * SIZE, court.w * SIZE, 2 * SIZE),
    rect(court.x * SIZE, (court.y + court.h - 2) * SIZE, court.w * SIZE, 2 * SIZE),
    rect(court.x * SIZE, court.y * SIZE, 2 * SIZE, court.h * SIZE),
    rect((court.x + court.w - 2) * SIZE, court.y * SIZE, 2 * SIZE, court.h * SIZE)];
  const courtElements = result.elements.filter(e => e.label === 'compound-keep' || e.label.startsWith('compound-court-cover-'));
  for (const e of courtElements) {
    const footprint = rect(e.x, e.y, e.template.w, e.template.h);
    assert.ok(bands.every(band => !shapesOverlap(band, footprint)), `${e.label} leaves the court perimeter clear`);
  }
  for (let i = 0; i < courtElements.length; i++) for (let j = 0; j < i; j++) {
    const a = courtElements[i], b = courtElements[j], gap = 2 * SIZE;
    assert.ok(a.x >= b.x + b.template.w + gap || b.x >= a.x + a.template.w + gap
      || a.y >= b.y + b.template.h + gap || b.y >= a.y + a.template.h + gap,
    `${a.label} and ${b.label} leave a two-cell bypass`);
  }
  const blockers = result.elements.flatMap(e => elementShapes(e));
  assert.deepEqual(validatePortalReach({ ...input, blockers }).errors, []);
  const mask = createAccessMask(input), radius = hunterClearance(SIZE), root = portalStands(input)[0].points[0];
  const targets = [ring, keep].flatMap(trace => [
    ...trace.allocation.spaces.map(space => ({ label: `${trace.label}/${space.id}`, point: spaceCenter(trace, space) })),
    ...trace.realization.openings.filter(opening => opening.kind === 'door').flatMap(opening => {
      const center = openingCenter(trace, opening);
      return [-1, 0, 1].map(offset => ({ label: `${trace.label}/${opening.connectionId}/${offset}`,
        point: { x: center.x + (opening.run.axis === 'v' ? offset * SIZE : 0),
          y: center.y + (opening.run.axis === 'h' ? offset * SIZE : 0) } }));
    }),
  ]);
  for (const { label, point } of targets)
    assert.ok(findRegionRoute(mask, blockers, root, point, radius), `reachable ${label}`);
});

test('a small court stays empty when no keep or cover can fit', () => {
  const { result, traces } = observed(brief('small-court', 1, cellsOf(14, 14), []));
  assert.ok(result.manifest.rooms >= 4);
  assert.ok(!traces.some(trace => trace.label === 'compound-keep'));
  assert.ok(!result.elements.some(e => e.label === 'compound-keep' || e.label.startsWith('compound-court-cover-')));
});

test('court composition is deterministic when brief cells are reversed', () => {
  const input = brief('court-order', 1, ...MASKS.field);
  const result = buildRegion(input);
  assert.deepEqual(buildRegion({ ...input, cells: [...input.cells].reverse() }).elements, result.elements);
});
