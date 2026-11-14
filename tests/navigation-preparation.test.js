import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareKnowledgeGeometry, createKnowledgePlanner } from '../shared/navigation/knowledge.ts';
import { openArea } from './helpers/arena.js';

const mapOf = () => ({ width: 576, height: 384, playableArea: openArea(576, 384, 96),
  obstacles: [{ id: 'wall', kind: 'building', x: 260, y: 170, w: 24, h: 70 }], gates: [] });
const all = { known: () => true, door: () => undefined, keys: 0, revision: 0 };

test('preparation builds every role and cell before any route, without changing the map', async () => {
  const map = mapOf(), original = structuredClone(map);
  let reads = 0, yields = 0;
  Object.defineProperty(map.obstacles[0], 'points', { get() { reads++; return undefined; }, configurable: true });
  await prepareKnowledgeGeometry(map, async () => { yields++; });
  assert.equal(yields, 12, 'six complete cells for each role');
  const built = reads;
  assert.ok(built > 0);
  for (const role of ['contestant', 'gladiator']) {
    const planner = createKnowledgePlanner(map, role), lazy = createKnowledgePlanner(mapOf(), role);
    for (let cell = 0; cell < 6; cell++) {
      const tile = planner.tile(all, cell);
      assert.equal(planner.tile(all, cell), tile, 'uses the prepared tile identity');
      assert.deepEqual(tile, lazy.tile(all, cell));
    }
    assert.deepEqual(planner.route(all, { x: 90, y: 90 }, { x: 490, y: 290 }),
      lazy.route(all, { x: 90, y: 90 }, { x: 490, y: 290 }));
  }
  assert.equal(reads, built, 'no first-use clipping after readiness');
  delete map.obstacles[0].points;
  assert.deepEqual(map, original);
});

test('cancelled tile preparation leaves complete tiles reusable and retries remaining cells', async () => {
  const map = mapOf();
  await assert.rejects(prepareKnowledgeGeometry(map, async () => { throw Error('cancel'); }), /cancel/);
  const planner = createKnowledgePlanner(map, 'contestant'), first = planner.tile(all, 0);
  await prepareKnowledgeGeometry(map, async () => {});
  assert.equal(planner.tile(all, 0), first);
  assert.deepEqual(planner.route(all, { x: 90, y: 90 }, { x: 490, y: 290 }),
    createKnowledgePlanner(mapOf(), 'contestant').route(all, { x: 90, y: 90 }, { x: 490, y: 290 }));
});
