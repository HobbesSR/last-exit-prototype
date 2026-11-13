import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { measureRoutes } from '../map/tools/routes.ts';
import { builtMapCollision, builtMapFrame } from '../map/micro/adapter.ts';
import { bodyRadius, sweptClear } from '../shared/movement.ts';
import { navigationMap } from '../shared/map/navigation.ts';

/** The Map Lab's contestant and hunter routes through a built map (53, "Routes"; #204). */

const built = (seed, params) => mapViews(generate(seed, params), GAME_ENGINES.compose).built;
const rounded = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

test('route lengths on a small playground are pinned', () => {
  const map = built('routes-5', { mode: 'playground', zoneWidth: 3, zoneHeight: 2 }), size = map.cellSize;
  const measure = measureRoutes(map, { x: 2.5 * size, y: 30 * size }, { x: 87.5 * size, y: 30 * size });
  assert.deepEqual({
    contestant: [rounded(measure.contestant.length), rounded(measure.contestant.walked)],
    hunter: [rounded(measure.hunter.length), rounded(measure.hunter.walked)],
    squeezes: measure.squeezes.map((run) => run.length),
  }, {
    contestant: [5094.214, 4875.873],
    hunter: [5578.88, 5323.362],
    squeezes: [1, 2, 2, 3],
  });
  assert.equal(rounded(measure.ratio), 1.095);
  for (const route of [measure.contestant, measure.hunter]) {
    assert.deepEqual(route.points[0], measure.from);
    assert.deepEqual(route.points.at(-1), measure.to);
  }
});

// A 36-unit opening admits contestant clearance 14 but excludes hunter clearance 25.
// The hunter can instead go around the bottom of this wall. Negative cells exercise the
// Lab/world translation without generating another map.
const passage = (offset = 0) => ({ cellSize: 40, pairs: [], regions: [{
  version: 'region-2', brief: { id: 'passage', type: 'open', seed: 1, cellSize: 40,
    cells: Array.from({ length: 120 }, (_, i) => ({ x: i % 12 + offset, y: Math.floor(i / 12) + offset })),
    zones: [], portals: [] },
  coreElements: [], loot: [], manifest: {}, elements: [{ label: 'wall', x: offset * 40, y: offset * 40,
    template: { w: 480, h: 400, parts: [
      { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 230, y: 0, w: 20, h: 182 } },
      { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 230, y: 218, w: 20, h: 102 } },
      { part: 'gate', x: 240, y: 200, w: 20, h: 36 },
    ] } }],
}] });

test('mesh measures body-specific, collision-clear routes and marks hunter-blocked legs', () => {
  const map = passage(-3), from = { x: -40, y: 80 }, to = { x: 280, y: 80 };
  const measure = measureRoutes(map, from, to, 'mesh');
  const collision = navigationMap(builtMapCollision(map), true), { origin } = builtMapFrame(map);
  const world = p => ({ x: p.x + origin.x, y: p.y + origin.y });
  assert.equal(measure.method, 'mesh');
  assert.ok(measure.hunter.length > measure.contestant.length);
  assert.ok(measure.squeezes.length > 0);
  for (const route of [measure.contestant, measure.hunter]) {
    assert.equal(route.status, 'complete');
    assert.deepEqual(route.points[0], from);
    assert.deepEqual(route.points.at(-1), to);
    assert.equal(route.walked, route.length);
    for (let i = 1; i < route.points.length; i++)
      assert.ok(sweptClear(collision, world(route.points[i - 1]), world(route.points[i]), bodyRadius(route)), 'the drawn route is traversable');
  }
  for (const run of measure.squeezes) for (let i = 1; i < run.length; i++)
    assert.equal(sweptClear(collision, world(run[i - 1]), world(run[i]), measure.hunter.clearance), false);
  const shifted = measureRoutes(passage(), { x: 80, y: 200 }, { x: 400, y: 200 }, 'mesh');
  assert.equal(shifted.contestant.length, measure.contestant.length);
  assert.equal(shifted.hunter.length, measure.hunter.length);
});

test('mesh refuses solid and out-of-map endpoints rather than snapping them to a route', () => {
  const map = passage(), from = { x: 80, y: 200 };
  for (const to of [{ x: 240, y: 80 }, { x: -80, y: 200 }]) {
    const measure = measureRoutes(map, from, to, 'mesh');
    for (const route of [measure.contestant, measure.hunter])
      assert.deepEqual([route.status, route.length, route.walked, route.points], ['invalid-endpoint', null, null, []]);
    assert.equal(measure.ratio, null);
    assert.deepEqual(measure.squeezes, []);
  }
});

test('mesh reports a disconnected target without drawing a partial route', () => {
  const map = passage();
  map.regions[0].elements[0].template.parts = [
    { part: 'obstacle', kind: 'building', shape: { kind: 'rect', x: 230, y: 0, w: 20, h: 400 } },
  ];
  const measure = measureRoutes(map, { x: 80, y: 200 }, { x: 400, y: 200 }, 'mesh');
  for (const route of [measure.contestant, measure.hunter])
    assert.deepEqual([route.status, route.length, route.points], ['no-known-route', null, []]);
  assert.equal(measure.ratio, null);
  const grid = measureRoutes(map, measure.from, measure.to, 'grid');
  for (const route of [grid.contestant, grid.hunter])
    assert.deepEqual([route.status, route.length, route.points], ['not-found', null, []]);
});
