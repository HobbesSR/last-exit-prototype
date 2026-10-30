import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalPlanner, portalGraphOf, regionAt, standJoins } from '../shared/navigation/portal-graph.ts';
import { gridReach, stepsLength } from '../shared/navigation/grid-level.ts';
import { meshReach } from '../shared/navigation/mesh-level.ts';
import { gridRoute } from '../shared/map/route.ts';
import { canOccupy, sweptClear, TILE } from '../shared/movement.ts';
import { generate } from '../map/chain.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../map/micro/adapter.ts';
import { generateLiveMap, liveChainParams } from '../map/live.ts';
import { createGame } from '../shared/simulation.ts';
import { DEFAULT_CELL_SIZE } from '../map/engines.ts';
import { buildPortalGraph } from '../map/navigation.ts';

// Navigation's top level is the portals generation guarantees between regions (22.6, #420).

const CELL = 48;

/** Regions side by side as columns of cells, `widths` cells wide and `height` tall, joined by the given portals. */
function strip(widths, height, joins) {
  const cols = widths.reduce((a, b) => a + b, 0), owner = new Int32Array(cols * height).fill(-1);
  let left = 0;
  const regions = widths.map((width, index) => {
    for (let row = 0; row < height; row++) for (let col = left; col < left + width; col++) owner[row * cols + col] = index;
    const box = { x: left * CELL, y: 0, w: width * CELL, h: height * CELL };
    left += width;
    return { id: `r${index}`, box, portals: [] };
  });
  const portals = joins.map(({ a, b, x, y }, node) => {
    const slots = [regions[a].portals.push(node) - 1, regions[b].portals.push(node) - 1];
    return { id: `p${node}`, x, y, stands: [], regions: [a, b], slots };
  });
  return { cellSize: CELL, cols, rows: height, owner, regions, portals };
}

/** A level below that measures straight lines, except between the pairs it is told are walled. */
const straightReach = (walled = []) => (from, targets) => targets.map(to =>
  walled.some(([p, q]) => p.x === from.x && p.y === from.y && q.x === to.x && q.y === to.y || q.x === from.x && q.y === from.y && p.x === to.x && p.y === to.y)
    ? null : Math.hypot(to.x - from.x, to.y - from.y));

test('a route crosses each region through its portals, in order, and ends at the goal', () => {
  const graph = strip([4, 4, 4], 4, [{ a: 0, b: 1, x: 192, y: 96 }, { a: 1, b: 2, x: 384, y: 96 }]);
  const route = createPortalPlanner(graph, straightReach()).route({ x: 48, y: 96 }, { x: 540, y: 96 });
  assert.equal(route.status, 'complete');
  assert.deepEqual(route.waypoints, [{ x: 192, y: 96 }, { x: 384, y: 96 }, { x: 540, y: 96 }]);
  assert.equal(route.length, 492);
});

test('the shorter of two crossings wins, and a crossing its region cannot reach is not taken', () => {
  const near = { x: 192, y: 24 }, far = { x: 192, y: 168 };
  const graph = strip([4, 4], 4, [{ a: 0, b: 1, ...near }, { a: 0, b: 1, ...far }]);
  const from = { x: 96, y: 24 }, to = { x: 288, y: 24 };
  assert.deepEqual(createPortalPlanner(graph, straightReach()).route(from, to).waypoints[0], near);
  // Walled off from the start: the planner goes around through the other crossing.
  assert.deepEqual(createPortalPlanner(graph, straightReach([[from, near]])).route(from, to).waypoints, [far, to]);
});

test('straight-line crossings without tables give the routes straight-line tables give', () => {
  const graph = strip([4, 4, 4, 4], 4, [{ a: 0, b: 1, x: 192, y: 24 }, { a: 0, b: 1, x: 192, y: 168 }, { a: 1, b: 2, x: 384, y: 96 }, { a: 2, b: 3, x: 576, y: 96 }]);
  const tabled = createPortalPlanner(graph, straightReach()), straight = createPortalPlanner(graph, straightReach(), 'straight');
  assert.deepEqual(straight.tables, [], 'nothing is measured');
  for (const [from, to] of [[{ x: 48, y: 24 }, { x: 700, y: 96 }], [{ x: 48, y: 168 }, { x: 300, y: 96 }], [{ x: 700, y: 96 }, { x: 48, y: 24 }]])
    assert.deepEqual(straight.route(from, to), tabled.route(from, to));
});

test('an unconnected pair inside a region is no route, and a point outside every region is an invalid endpoint', () => {
  const graph = strip([4, 4, 4], 4, [{ a: 0, b: 1, x: 192, y: 96 }, { a: 1, b: 2, x: 384, y: 96 }]);
  const planner = createPortalPlanner(graph, straightReach([[{ x: 192, y: 96 }, { x: 384, y: 96 }]]));
  assert.ok(planner.tables[1].includes(Infinity), 'the walled pair is recorded as unreached');
  assert.equal(planner.route({ x: 48, y: 96 }, { x: 540, y: 96 }).status, 'no-route');
  assert.equal(planner.route({ x: -10, y: 96 }, { x: 540, y: 96 }).status, 'invalid-endpoint');
  assert.equal(regionAt(graph, { x: 200, y: 10 }), 1);
});

test('a detour past today\'s search box is found through the portal around the wall', () => {
  // Two regions split by a wall along their seam that leaves one gap, 2200 units from both ends.
  const width = 24, height = 56, playableArea = { cellSize: CELL, rows: Array.from({ length: height }, (_, y) => ({ y, runs: [[0, width]] })) };
  const map = { width: width * CELL, height: height * CELL, playableArea, gates: [],
    obstacles: [{ id: 'wall', kind: 'wall', x: 12 * CELL - 16, y: 0, w: 16, h: 2352 }] };
  const graph = strip([12, 12], height, [{ a: 0, b: 1, x: 12 * CELL, y: 2500 }]);
  const from = { x: 480, y: 120 }, to = { x: 700, y: 120 };
  for (const reach of [meshReach(map, 'contestant', graph), gridReach(map, 'contestant', graph)]) {
    const route = createPortalPlanner(graph, reach).route(from, to);
    assert.equal(route.status, 'complete');
    assert.deepEqual(route.waypoints[0], { x: 576, y: 2500 });
  }
  // The box around both ends plus 600 units stops short of the gap, so today's planner finds nothing.
  const x = 0, y = 0, box = { x, y, width: Math.ceil((700 + 600) / TILE), height: Math.ceil((120 + 600) / TILE) };
  assert.equal(gridRoute(map, 'contestant', box, from, to, true), null);
});

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

/** An open map of `cols` × `rows` cells with one thin wall, 4 units thick: thinner than the gap between two clear tile disks. */
function thinWall(cols, rows, wall) {
  const playableArea = { cellSize: CELL, rows: Array.from({ length: rows }, (_, y) => ({ y, runs: [[0, cols]] })) };
  return { width: cols * CELL, height: rows * CELL, playableArea, gates: [], obstacles: [{ id: 'thin', kind: 'wall', ...wall }] };
}

test('a body cannot sweep through a wall that both ends of the move are clear of', () => {
  const map = thinWall(4, 4, { x: 38, y: 0, w: 4, h: 192 });
  const a = { x: 20, y: 100 }, b = { x: 60, y: 100 };
  assert.ok(canOccupy(map, a.x, a.y, 14) && canOccupy(map, b.x, b.y, 14), 'both tile centres are clear');
  assert.equal(sweptClear(map, a, b, 14), false);
  assert.equal(sweptClear(map, b, { x: 100, y: 100 }, 14), true);
});

test('the grid level never links tiles across a thin wall, where the unswept grid does', () => {
  const map = thinWall(4, 4, { x: 38, y: 0, w: 4, h: 192 });
  const graph = strip([4], 4, []), from = { x: 20, y: 100 }, to = { x: 100, y: 100 };
  assert.deepEqual(gridReach(map, 'contestant', graph)(from, [to], 0), [null]);
  const box = { x: 0, y: 0, width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) };
  assert.ok(gridRoute(map, 'contestant', box, from, to, true), 'the unswept grid steps over the wall');
});

test('a portal whose stands a wall divides is reported for each region that promises they join', () => {
  // A horizontal wall across both regions, between the portal's two stands.
  const map = thinWall(4, 6, { x: 0, y: 138, w: 192, h: 4 });
  const graph = strip([2, 2], 6, [{ a: 0, b: 1, x: 96, y: 60 }, { a: 0, b: 1, x: 96, y: 20 }]);
  graph.portals[0].stands = [{ x: 96, y: 60 }, { x: 96, y: 220 }];
  const divided = standJoins(graph, gridReach(map, 'contestant', graph));
  assert.deepEqual(divided, [{ portal: 'p0', region: 'r0', unreached: 1, stands: 2 }, { portal: 'p0', region: 'r1', unreached: 1, stands: 2 }]);
  graph.portals[0].stands = [{ x: 96, y: 60 }, { x: 96, y: 100 }];
  assert.deepEqual(standJoins(graph, gridReach(map, 'contestant', graph)), []);
});

test('an endpoint whose only walkable tile lies across a wall is unreachable, not routed through it', () => {
  // The point is clear for a body, but its own tile is too near the thin wall, the tile behind it
  // is under a block, and the first walkable tile is across the wall: `gridRoute`'s fallback.
  const map = thinWall(4, 4, { x: 58, y: 0, w: 4, h: 192 });
  map.obstacles.push({ id: 'block', kind: 'wall', x: 0, y: 0, w: 30, h: 192 });
  const graph = strip([4], 4, []), from = { x: 45, y: 100 }, to = { x: 140, y: 100 };
  assert.ok(canOccupy(map, from.x, from.y, 12), 'a contestant can stand there');
  const box = { x: 0, y: 0, width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) };
  assert.ok(gridRoute(map, 'contestant', box, from, to, true), 'the unswept snapping falls back across the wall');
  assert.deepEqual(gridReach(map, 'contestant', graph)(from, [to], 0), [null]);
  assert.deepEqual(gridReach(map, 'contestant', graph)(to, [from], 0), [null], 'as a target too');
});

test('a live map carries its portal graph beside it, never in it', () => {
  const map = generateLiveMap(1), graph = portalGraphOf(map);
  assert.ok(graph?.portals.length, 'live assembly attaches the graph');
  assert.equal(Object.keys(map).some(key => map[key] === graph), false, 'not a field of the map');
  assert.equal(JSON.stringify(map).includes('"owner"'), false, 'so no recording or projection serializes it');
  assert.equal(portalGraphOf(structuredClone(map)), undefined, 'and no clone carries it');
  assert.equal(portalGraphOf(createGame(1, map).map), graph, 'the game holds the same map, graph and all');
});
