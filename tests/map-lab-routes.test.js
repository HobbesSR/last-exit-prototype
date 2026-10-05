import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/tools/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { builtMapCollision } from '../map/micro/adapter.ts';
import { measureRoutes } from '../map/tools/routes.ts';
import { canOccupy } from '../shared/movement.ts';

/** The Map Lab's contestant and hunter routes through a built map (53, "Routes"; #204). */

const built = (seed, params) => mapViews(generate(seed, params), GAME_ENGINES.compose).built;
const rounded = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

test('route lengths on a small playground are pinned', () => {
  const map = built('routes-2', { mode: 'playground', zoneWidth: 3, zoneHeight: 2 }), size = map.cellSize;
  const measure = measureRoutes(map, { x: 2.5 * size, y: 30 * size }, { x: 87.5 * size, y: 30 * size });
  assert.deepEqual({
    contestant: [rounded(measure.contestant.length), rounded(measure.contestant.walked)],
    hunter: [rounded(measure.hunter.length), rounded(measure.hunter.walked)],
    squeezes: measure.squeezes.map((run) => run.length),
  }, {
    contestant: [4164.667, 4136.221],
    hunter: [4164.667, 4135.754],
    squeezes: [1],
  });
  assert.equal(rounded(measure.ratio), 1);
  for (const route of [measure.contestant, measure.hunter]) {
    assert.deepEqual(route.points[0], measure.from);
    assert.deepEqual(route.points.at(-1), measure.to);
  }
});

test('a game map: both bodies reach the exit from a spawn, and the void is plainly unreachable', () => {
  const map = built('exit-1', {}), sites = map.regions.flatMap((region) => region.coreElements);
  const spawn = sites.find((site) => site.kind === 'spawn'), exit = sites.find((site) => site.kind === 'exit');
  const measure = measureRoutes(map, spawn, exit);
  assert.ok(measure.contestant.length > 0 && measure.hunter.length > 0);
  // The contestant's grid admits everything the hunter's does, so its route can't be longer.
  assert.ok(measure.ratio >= 1 - 1e-9, `ratio ${measure.ratio}`);
  assert.ok(measure.squeezes.length > 0);
  // Cell (0, 0) is outside the map's lozenge mask, far from any region.
  const lost = measureRoutes(map, spawn, { x: map.cellSize / 2, y: map.cellSize / 2 });
  for (const route of [lost.contestant, lost.hunter]) assert.deepEqual([route.length, route.walked, route.points], [null, null, []]);
  assert.equal(lost.ratio, null);
});

test("a built map's collision is bounded by its regions' cells, as a live match's is", () => {
  const map = built('exit-1', {}), collision = builtMapCollision(map);
  assert.ok(collision.playableArea);
  // Sites at the map's straight left edge, which a diamond bound would put outside the map.
  for (const site of map.regions.flatMap((region) => region.coreElements))
    assert.ok(canOccupy(collision, site.x, site.y, 23), `${site.kind} at ${site.x},${site.y}`);
});
