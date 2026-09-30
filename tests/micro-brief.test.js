import test from 'node:test';
import assert from 'node:assert/strict';
import { REGION_TYPES, briefErrors, buildRegion } from '../map/micro/region-types.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { rect } from '../shared/shape.ts';

/** A 24 × 18 region with a portal on its west and east sides, and two zones split at x = 12. */
function brief(type = 'example-depot', seed = 4217) {
  const cells = [];
  for (let y = 0; y < 18; y++) for (let x = 0; x < 24; x++) cells.push({ x, y });
  return { id: 'r1', seed, type, cellSize: 40, cells,
    zones: [{ tier: 1, bonus: 0, lootChance: 0.5, cells: cells.filter(c => c.x < 12) }, { tier: 3, bonus: 1, lootChance: 1, cells: cells.filter(c => c.x >= 12) }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 3 }] };
}
const blockersOf = result => result.elements.flatMap(e => elementShapes(e));

test('a brief dispatches to its region type\'s strategy', () => {
  const ran = [], registry = { a: b => (ran.push(['a', b.id]), 'A'), b: b => (ran.push(['b', b.id]), 'B') };
  assert.equal(buildRegion(brief('b'), registry), 'B');
  assert.deepEqual(ran, [['b', 'r1']]);
  assert.throws(() => buildRegion(brief('c'), registry), /Unknown region type c/);
  const result = buildRegion(brief('example-ruins'));
  assert.equal(result.version, 'region-1');
  assert.equal(result.brief.type, 'example-ruins');
  assert.ok(Object.isFrozen(REGION_TYPES));
});

test('a brief\'s portals are kept, never walled, and the example keeps its promise', () => {
  for (const type of Object.keys(REGION_TYPES)) for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(type, seed));
    assert.ok(result.elements.every(e => !e.label.startsWith('port:')), type);
    const check = validatePortalReach({ ...result.brief, blockers: blockersOf(result) });
    assert.deepEqual(check.errors, [], `${type} seed ${seed}`);
    assert.equal(check.routes.length, 1);
  }
});

test('the whole-portal promise is refused when a builder narrows a portal or cuts it off', () => {
  const result = buildRegion(brief('example-open')), blockers = blockersOf(result);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers }).errors, []);
  // A post in the east portal's mouth leaves a doorway, but not the whole portal.
  const narrowed = validatePortalReach({ ...result.brief, blockers: [...blockers, rect(924, 360, 16, 16)] });
  assert.ok(narrowed.errors.some(e => /Portal east is obstructed/.test(e)), narrowed.errors.join(' '));
  const cut = validatePortalReach({ ...result.brief, blockers: [...blockers, rect(470, 0, 20, 720)] });
  assert.ok(cut.errors.some(e => /unreachable from portal west/.test(e)), cut.errors.join(' '));
});

test('a wall sitting right on the boundary seals the portal even when no stand disc touches it', () => {
  // A thin sliver at the west boundary, spanning the whole portal, that no inset stand circle reaches.
  const sliver = [rect(0, 320, 0.5, 80)];
  const sealed = validatePortalReach({ ...brief(), blockers: sliver });
  assert.ok(sealed.errors.some(e => /Portal west is obstructed/.test(e)), sealed.errors.join(' '));
  // The same sliver clear of every portal changes nothing.
  const clear = validatePortalReach({ ...brief(), blockers: [rect(0, 0, 0.5, 80)] });
  assert.deepEqual(clear.errors, []);
});

test('a brief whose portals cannot connect fails explicitly, not silently', () => {
  // Two 2×2 lobes joined by a single-cell corridor: too narrow for a hunter to cross.
  const cells = [];
  for (const x of [0, 1, 3, 4]) for (const y of [0, 1]) cells.push({ x, y });
  cells.push({ x: 2, y: 0 });
  const lobes = { id: 'lobes', seed: 1, type: 'example-open', cellSize: 40, cells,
    zones: [{ tier: 1, bonus: 0, lootChance: 0, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }, { id: 'east', axis: 'v', x: 5, y: 0, length: 2 }] };
  assert.throws(() => buildRegion(lobes), /cannot connect/);
});

test('one portal carries no reachability requirement', () => {
  const one = { ...brief(), portals: [brief().portals[0]] };
  const sealed = [rect(0, 0, 200, 720)];
  assert.deepEqual(validatePortalReach({ ...one, blockers: sealed }), { valid: true, errors: [], routes: [] });
});

test('portal stands cover the whole portal from inside the region', () => {
  const [west, east] = portalStands(brief());
  assert.deepEqual(west.inward, { x: 1, y: 0 });
  assert.deepEqual(east.inward, { x: -1, y: 0 });
  const radius = 40 * (0.875 + 0.05);
  for (const { portal, points } of [west, east]) {
    assert.equal(points[0].y, portal.y * 40 + radius);
    assert.equal(points.at(-1).y, (portal.y + portal.length) * 40 - radius);
    for (let i = 1; i < points.length; i++) assert.ok(points[i].y - points[i - 1].y <= 20);
  }
  assert.throws(() => portalStands({ ...brief(), portals: [{ id: 'inside', axis: 'v', x: 5, y: 2, length: 2 }] }), /perimeter/);
  assert.equal(portalStands({ ...brief(), portals: [{ id: 'short', axis: 'v', x: 0, y: 2, length: 1 }] })[0].points.length, 0);
});

test('features are sited before loot, and loot follows each cell\'s zone', () => {
  const input = { ...brief('example-entry'), features: { spawn: 6, 'hunter-spawn': 1, exit: 2 } };
  const result = buildRegion(input);
  const count = kind => result.features.filter(f => f.kind === kind).length;
  assert.deepEqual([count('spawn'), count('hunter-spawn'), count('exit')], [6, 1, 2]);
  assert.equal(result.manifest.features, 9);
  assert.ok(result.loot.length > 0);
  for (const spot of result.loot) assert.equal(spot.tier, spot.x < 480 ? 1 : 3);
  const none = buildRegion({ ...brief('example-entry'), zones: brief().zones.map(z => ({ ...z, lootChance: 0 })) });
  assert.deepEqual(none.loot, []);
  assert.deepEqual(buildRegion(input), result, 'deterministic');
});

test('zone loot chance gates loot a builder places directly, not only the remaining fill', () => {
  const zeroChance = zones => brief('example-open').zones.map(z => ({ ...z, lootChance: zones }));
  // 'open' offers loot from inside its own rooms, before the remaining-loot fill ever runs.
  assert.deepEqual(buildRegion({ ...brief('example-open'), zones: zeroChance(0) }).loot, []);
  assert.ok(buildRegion({ ...brief('example-open'), zones: zeroChance(1) }).loot.length > 0);
});

test('builder-placed loot never overlaps a later-sited feature spawn', () => {
  const metrics = microMetrics({ cellSize: 40, bodyProfile: 'cell' });
  for (const type of Object.keys(REGION_TYPES)) for (const seed of [1, 2, 3]) {
    const result = buildRegion({ ...brief(type, seed), features: { spawn: 10 } });
    for (const spot of result.loot) for (const site of result.features) {
      const gap = Math.hypot(spot.x - site.x, spot.y - site.y) - metrics.lootRadius - metrics.clearance.contestant;
      assert.ok(gap >= -1e-6, `${type} seed ${seed}: loot (${spot.x},${spot.y}) overlaps spawn (${site.x},${site.y})`);
    }
  }
});

test('a malformed brief is refused by name, before any strategy runs', () => {
  const unzoned = brief(); unzoned.zones[0].cells.pop();
  assert.ok(briefErrors(unzoned).some(e => /exactly one zone/.test(e)));
  assert.ok(briefErrors({ ...brief(), features: { treasure: 1 } }).some(e => /Unknown feature treasure/.test(e)));
  assert.ok(briefErrors({ ...brief(), features: { exit: 1.5 } }).some(e => /count/.test(e)));
  assert.throws(() => buildRegion({ ...brief(), portals: undefined }), /Invalid brief/);
  assert.deepEqual(briefErrors(brief()), []);
});
