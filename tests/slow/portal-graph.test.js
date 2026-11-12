import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalPlanner, portalGraphOf, standJoins } from '../../shared/navigation/portal-graph.ts';
import { stepsLength } from '../../shared/navigation/grid-level.ts';
import { meshReach } from '../../shared/navigation/mesh-level.ts';
import { gridRoute } from '../../shared/map/route.ts';
import { TILE } from '../../shared/movement.ts';
import { generate } from '../../map/chain.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../../map/micro/adapter.ts';
import { generateLiveMap, liveChainParams } from '../../map/live.ts';
import { createGame, disposePhysics } from '../../shared/simulation.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { DEFAULT_CELL_SIZE } from '../../map/engines.ts';
import { buildPortalGraph } from '../../map/navigation.ts';

// Moved from tests/portal-graph.test.js (#849): each builds a live map, slow-tier work (31).

test('on a live map every promised pair connects over the mesh, and routes stay close to the unrestricted grid search', () => {
  const built = composeRegions(generate(1, liveChainParams(), undefined, DEFAULT_CELL_SIZE).results);
  const { origin } = builtMapFrame(built), collision = builtMapCollision(built);
  const graph = buildPortalGraph(built, origin);
  assert.deepEqual(buildPortalGraph(built, origin), graph, 'derivation is deterministic');
  assert.ok(graph.portals.every(p => p.regions[0] !== p.regions[1]), 'every portal joins two regions');
  const sites = built.regions.flatMap(r => r.coreElements).map(s => ({ kind: s.kind, x: s.x + origin.x, y: s.y + origin.y }));
  const from = sites.find(s => s.kind === 'spawn'), to = sites.find(s => s.kind === 'exit');
  const full = { x: 0, y: 0, width: Math.ceil(collision.width / TILE), height: Math.ceil(collision.height / TILE) };
  for (const role of ['contestant', 'gladiator']) {
    const reach = meshReach(collision, role, graph), planner = createPortalPlanner(graph, reach);
    assert.ok(planner.tables.every(table => !table.includes(Infinity)), `${role}: every portal reaches every other in its region`);
    assert.deepEqual(standJoins(graph, reach), [], `${role}: every portal's stands join`);
    assert.deepEqual(reach.defects, [], `${role}: collision accepts every path the mesh found`);
    const route = planner.route(from, to), reference = stepsLength(from, gridRoute(collision, role, full, from, to, true), to);
    assert.equal(route.status, 'complete');
    // Any-angle legs undercut the grid's tile steps; crossing each portal at its middle stand costs a little back.
    assert.ok(route.length >= Math.hypot(to.x - from.x, to.y - from.y) && route.length <= reference * 1.1, `${role}: ${route.length} against ${reference}`);
  }
});

test('a live map carries its portal graph beside it, never in it', async () => {
  const map = generateLiveMap(1), graph = portalGraphOf(map);
  assert.ok(graph?.portals.length, 'live assembly attaches the graph');
  assert.equal(Object.keys(map).some(key => map[key] === graph), false, 'not a field of the map');
  assert.equal(JSON.stringify(map).includes('"owner"'), false, 'so no recording or projection serializes it');
  assert.equal(portalGraphOf(structuredClone(map)), undefined, 'and no clone carries it');
  const game = await createGame(1, map, defaultContent());
  try { assert.equal(portalGraphOf(game.map), graph, 'the game holds the same map, graph and all'); } finally { disposePhysics(game); }
});
