import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalPlanner, regionAt } from '../shared/navigation/portal-graph.ts';
import { gridReach, stepsLength } from '../shared/navigation/grid-level.ts';
import { gridRoute } from '../shared/map/route.ts';
import { TILE } from '../shared/movement.ts';
import { generate } from '../map/chain.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../map/micro/adapter.ts';
import { liveChainParams } from '../map/live.ts';
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
    return { id: `p${node}`, x, y, regions: [a, b], slots };
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

test('a broken promise inside a region is no route, and a point outside every region is an invalid endpoint', () => {
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
  const route = createPortalPlanner(graph, gridReach(map, 'contestant', graph)).route(from, to);
  assert.equal(route.status, 'complete');
  assert.deepEqual(route.waypoints[0], { x: 576, y: 2500 });
  // The box around both ends plus 600 units stops short of the gap, so today's planner finds nothing.
  const x = 0, y = 0, box = { x, y, width: Math.ceil((700 + 600) / TILE), height: Math.ceil((120 + 600) / TILE) };
  assert.equal(gridRoute(map, 'contestant', box, from, to, true), null);
});

test('on a live map every promised pair connects, and routes stay close to the unrestricted search', () => {
  const built = composeRegions(generate(1, liveChainParams(), undefined, DEFAULT_CELL_SIZE).results);
  const { origin } = builtMapFrame(built), collision = builtMapCollision(built);
  const graph = buildPortalGraph(built, origin);
  assert.deepEqual(buildPortalGraph(built, origin), graph, 'derivation is deterministic');
  assert.ok(graph.portals.every(p => p.regions[0] !== p.regions[1]), 'every portal joins two regions');
  const sites = built.regions.flatMap(r => r.coreElements).map(s => ({ kind: s.kind, x: s.x + origin.x, y: s.y + origin.y }));
  const from = sites.find(s => s.kind === 'spawn'), to = sites.find(s => s.kind === 'exit');
  const full = { x: 0, y: 0, width: Math.ceil(collision.width / TILE), height: Math.ceil(collision.height / TILE) };
  for (const role of ['contestant', 'gladiator']) {
    const planner = createPortalPlanner(graph, gridReach(collision, role, graph));
    assert.ok(planner.tables.every(table => !table.includes(Infinity)), `${role}: every portal reaches every other in its region`);
    const route = planner.route(from, to), reference = stepsLength(from, gridRoute(collision, role, full, from, to, true), to);
    assert.equal(route.status, 'complete');
    // Grid lengths through tile centres can undercut the hierarchy only by the hierarchy's own detours.
    assert.ok(route.length >= reference - 1e-6 && route.length <= reference * 1.1, `${role}: ${route.length} against ${reference}`);
  }
});
