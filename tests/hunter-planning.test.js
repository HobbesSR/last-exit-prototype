import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// Under `hunterPlanning: 'portals'` a gladiator plans a trip across regions a leg at a time (#682, 22.6). The core's
// planner runs in every started game, so these start one and read the gladiator's planned route from the core.

const CELL = 192, REGIONS = 4, WIDTH = 4 * CELL;

/**
 * Four regions side by side, walled from each other except for one gap each, with the exit in the last. Each wall
 * leaves a gap at y 0–192, 384–576 or 0–192 in turn, so a trip zigzags. A contestant stands in the last region, so
 * the gladiator has a long trip to make.
 */
async function hunt(planning, { graph = true } = {}) {
  const { map, crossings } = arena({ cols: 4 * REGIONS, rows: 3, cellSize: CELL, corridor: { gaps: [0, 2, 0] } });
  const content = planning ? { ...contentById('content-6'), hunterPlanning: planning } : contentById('content-6');
  // A copy of the map carries no portal graph.
  const { s, players: [gladiator] } = await stagePhysics(graph ? map : { ...map }, { content,
    actors: [{ role: 'gladiator', x: 300, y: 480 }, { role: 'contestant', bot: false, x: 2900, y: 288 }] });
  const { match, boundary } = startGame(s);
  /** Step until the gladiator has a route that begins east of `x`; its points. */
  const plan = (after = 0) => {
    for (let i = 0; i < 120; i++) { stepGame(s); const route = match.botRoute(gladiator.id); if (route[0]?.x > after) return route; }
    return null;
  };
  return { s, crossings, exit: map.exit, gladiator, boundary, plan };
}
const length = route => route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0);

test('a gladiator plans only as far as the crossing after next, then on to the goal', async t => {
  const { s, crossings, exit, gladiator, boundary, plan } = await hunt('portals');
  t.after(() => disposePhysics(s));
  const route = plan();
  assert.ok(route?.length, 'it plans');
  assert.deepEqual(route.at(-1), crossings[1], 'the first leg ends at the second crossing');
  // Standing in the third region, the next crossing leads into the goal's region, so the leg is the trip's end.
  assert.ok(boundary.teleport(gladiator.id, [2 * WIDTH + 200, 480]));
  assert.deepEqual(plan(1700)?.at(-1), exit, 'it plans to the exit');
});

test('without the setting, or on a map without a portal graph, a gladiator plans the whole way', async t => {
  for (const options of [[undefined], ['portals', { graph: false }]]) {
    const { s, exit, plan } = await hunt(...options);
    t.after(() => disposePhysics(s));
    assert.deepEqual(plan()?.at(-1), exit, options.length > 1 ? 'a copied map carries no graph' : 'no setting');
  }
});

test('a leg is a shorter plan than the whole trip', async t => {
  const trips = {};
  for (const planning of [undefined, 'portals']) {
    const { s, plan } = await hunt(planning);
    t.after(() => disposePhysics(s));
    trips[planning ?? 'whole'] = plan();
  }
  assert.ok(trips.portals.length < trips.whole.length, `${trips.portals.length} points against ${trips.whole.length}`);
  assert.ok(length(trips.portals) < length(trips.whole), 'and covers less ground');
});

test('content-7 is content-6 with gladiators planning over the portal graph', () => {
  const { id, hunterPlanning, ...seven } = contentById('content-7'), { id: six, ...rest } = contentById('content-6');
  assert.deepEqual([id, six, hunterPlanning, seven], ['content-7', 'content-6', 'portals', rest]);
});
