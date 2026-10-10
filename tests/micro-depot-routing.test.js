import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRegion } from '../map/micro/region-types.ts';
import { capsule, createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { protectedRoutes } from '../map/micro/strategies/scatter.ts';
import { rect } from '../shared/shape.ts';

// Row runs preserve the production briefs' coordinates, seed, margins, zones, and portal order.
const expand = runs => runs.flatMap(([x, y, length]) => Array.from({ length }, (_, i) => ({ x: x + i, y })));
const witnesses = JSON.parse(readFileSync(new URL('./fixtures/micro-depot-routing.json', import.meta.url)));
const witnessBrief = fixture => ({ ...fixture, cells: expand(fixture.cells), fillCells: expand(fixture.fillCells),
  clearCells: expand(fixture.clearCells), zones: fixture.zones.map(zone => ({ ...zone, cells: expand(zone.cells) })) });

test('depot witnesses leave room for warehouses and rows while preserving portal reach', () => {
  for (const fixture of witnesses) {
    const brief = witnessBrief(fixture), result = buildRegion(brief);
    assert.ok(result.manifest.warehouses > 0, `seed ${fixture.witness}: warehouses`);
    assert.ok(result.manifest.rows > 0, `seed ${fixture.witness}: rows`);
    assert.deepEqual(validateFillConstraints(result.brief, result.elements.flatMap(element => elementShapes(element, true))),
      [], `seed ${fixture.witness}: fill margins`);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: result.elements.flatMap(element => elementShapes(element)) }).errors,
      [], `seed ${fixture.witness}: portal reach`);
  }
});

test('depot witnesses keep placements under reversed cell order', () => {
  for (const fixture of witnesses) {
    const brief = witnessBrief(fixture), forward = buildRegion(brief);
    const reversed = buildRegion({ ...brief, cells: [...brief.cells].reverse(), fillCells: [...brief.fillCells].reverse(),
      clearCells: [...brief.clearCells].reverse(), zones: brief.zones.map(zone => ({ ...zone, cells: [...zone.cells].reverse() })) });
    assert.deepEqual(reversed.elements, forward.elements, `seed ${fixture.witness}`);
  }
});

test('the default protection is the original first-portal star, and the opt-in tree keeps whole portal strips', () => {
  const brief = { id: 'routing', seed: 1, type: 'depot', cellSize: 40,
    cells: Array.from({ length: 12 }, (_, y) => Array.from({ length: 20 }, (_, x) => ({ x, y }))).flat(),
    zones: [], portals: [
      { id: 'west', axis: 'v', x: 0, y: 2, length: 3 },
      { id: 'north', axis: 'h', x: 15, y: 0, length: 3 },
      { id: 'east', axis: 'v', x: 20, y: 8, length: 3 },
    ] };
  const stands = portalStands(brief), radius = hunterClearance(brief.cellSize), mask = createAccessMask(brief);
  const strips = stands.map(({ portal }) => {
    const line = (portal.axis === 'h' ? portal.y : portal.x) * brief.cellSize;
    const start = (portal.axis === 'h' ? portal.x : portal.y) * brief.cellSize;
    return portal.axis === 'h' ? rect(start, line - radius, portal.length * brief.cellSize, 2 * radius)
      : rect(line - radius, start, 2 * radius, portal.length * brief.cellSize);
  });
  const swept = (a, b) => {
    const route = findRegionRoute(mask, [], stands[a].points[0], stands[b].points[0], radius);
    assert.ok(route);
    return route.slice(1).flatMap((point, i) => capsule(route[i], point, radius));
  };
  const star = [...strips, ...swept(0, 1), ...swept(0, 2)];
  const tree = [...strips, ...swept(0, 1), ...swept(1, 2)];
  assert.deepEqual(protectedRoutes(brief, 'Test'), star);
  assert.deepEqual(protectedRoutes(brief, 'Test', 'root'), star);
  assert.deepEqual(protectedRoutes(brief, 'Test', 'nearby'), tree);
});

test('nearby tree rejects disconnected portals in the empty shape', () => {
  const cells = [0, 10].flatMap(start => Array.from({ length: 6 }, (_, y) =>
    Array.from({ length: 6 }, (_, x) => ({ x: start + x, y }))).flat());
  const brief = { id: 'disconnected', seed: 1, type: 'depot', cellSize: 40, cells, zones: [],
    portals: [{ id: 'left', axis: 'v', x: 0, y: 1, length: 3 },
      { id: 'right', axis: 'v', x: 16, y: 1, length: 3 }] };
  assert.throws(() => protectedRoutes(brief, 'Depot', 'nearby'), /cannot join portal right/);
});

test('equal-distance nearby choices follow portal order', () => {
  const brief = { id: 'ties', seed: 1, type: 'depot', cellSize: 40,
    cells: Array.from({ length: 12 }, (_, y) => Array.from({ length: 12 }, (_, x) => ({ x, y }))).flat(), zones: [],
    portals: [{ id: 'middle', axis: 'v', x: 0, y: 5, length: 2 },
      { id: 'top', axis: 'v', x: 0, y: 0, length: 2 },
      { id: 'bottom', axis: 'v', x: 0, y: 10, length: 2 }] };
  const stands = portalStands(brief), mask = createAccessMask(brief), radius = hunterClearance(brief.cellSize);
  const route = (a, b) => {
    const points = findRegionRoute(mask, [], stands[a].points[0], stands[b].points[0], radius);
    assert.ok(points);
    return points.slice(1).flatMap((point, i) => capsule(points[i], point, radius));
  };
  const strips = stands.map(({ portal }) => rect(-radius, portal.y * brief.cellSize, 2 * radius, portal.length * brief.cellSize));
  assert.deepEqual(protectedRoutes(brief, 'Depot', 'nearby'), [...strips, ...route(0, 1), ...route(0, 2)]);
});
