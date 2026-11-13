import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { measureRoutes } from '../map/tools/routes.ts';

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
