import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../map/tools/core.ts';
import { GAME_ENGINES } from '../../map/engines.ts';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { builtMapCollision } from '../../map/micro/adapter.ts';
import { measureRoutes } from '../../map/tools/routes.ts';
import { canOccupy } from '../../shared/movement.ts';

/** The Map Lab's contestant and hunter routes through a built map (53, "Routes"; #204). */

const built = (seed, params) => mapViews(generate(seed, params), GAME_ENGINES.compose).built;
const rounded = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

// Moved from tests/map-lab-routes.test.js (#849): each builds a 12 x 6 game map, slow-tier work (31).

test('a game map: both bodies reach the exit from a spawn, and the void is plainly unreachable', () => {
  // A current-library seed whose spawn-to-exit route includes a squeeze.
  const map = built('exit-3', {}), sites = map.regions.flatMap((region) => region.coreElements);
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
  // Reuse the same generated game map for the opt-in planner; no second generation.
  const mesh = measureRoutes(map, spawn, exit, 'mesh');
  for (const route of [mesh.contestant, mesh.hunter]) {
    assert.equal(route.status, 'complete');
    assert.ok(route.length > 0);
    assert.deepEqual(route.points[0], { x: spawn.x, y: spawn.y });
    assert.deepEqual(route.points.at(-1), { x: exit.x, y: exit.y });
  }
  const meshLost = measureRoutes(map, spawn, { x: map.cellSize / 2, y: map.cellSize / 2 }, 'mesh');
  for (const route of [meshLost.contestant, meshLost.hunter])
    assert.deepEqual([route.status, route.length, route.points], ['invalid-endpoint', null, []]);
});

test("a built map's collision is bounded by its regions' cells, as a live match's is", () => {
  const map = built('exit-1', {}), collision = builtMapCollision(map);
  assert.ok(collision.playableArea);
  // Sites at the map's straight left edge, which a diamond bound would put outside the map.
  for (const site of map.regions.flatMap((region) => region.coreElements))
    assert.ok(canOccupy(collision, site.x, site.y, 23), `${site.kind} at ${site.x},${site.y}`);
});
