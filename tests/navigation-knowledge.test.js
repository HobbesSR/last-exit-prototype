import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRoute, contestantKnowledge, createKnowledgePlanner, frozenKnowledge, packedTilesFor } from '../shared/navigation/knowledge.ts';
import { adoptPackedTiles, freeSpaceTile } from '../shared/free-space.ts';
import { createDiscovery, discover, discoveryGrid, observeGate } from '../shared/discovery.ts';
import { sweptClear } from '../shared/movement.ts';
import { bounds, shapeOf } from '../shared/shape.ts';
import { generateLiveMap } from '../map/live.ts';

// A contestant plans over what it has discovered, assuming unknown ground open (22.6, #423).

const S = 192, COLS = 24, ROWS = 12;

/** Open ground COLS × ROWS cells, less `voids` ([row, from, to] in cells), with the given obstacles and doors. */
function field({ obstacles = [], gates = [], voids = [] } = {}) {
  const rows = Array.from({ length: ROWS }, (_, y) => {
    const cut = voids.filter(([row]) => row === y).sort((a, b) => a[1] - b[1]);
    const runs = [];
    let from = 0;
    for (const [, a, b] of cut) { if (a > from) runs.push([from, a]); from = b; }
    if (from < COLS) runs.push([from, COLS]);
    return { y, runs };
  });
  return { width: COLS * S, height: ROWS * S, playableArea: { cellSize: S, rows }, obstacles, gates, buildings: [] };
}
const box = (id, x, y, w, h) => ({ id, kind: 'wall', x, y, w, h });
const door = (id, x, y, state = {}) => ({ id, kind: 'door', x, y, w: 12, h: 96, open: false, locked: false, ...state });
/** A wall across the whole field at `x`, with a doorway at its middle that `door` may fill. */
const wallWithDoorway = (id, x) => [box(`${id}-n`, x - 6, 0, 12, 1104), box(`${id}-s`, x - 6, 1200, 12, 1104)];

/** Knowledge of the given cells, with doors as observed. */
function knowing(cells, { gates = {}, keys = 0, revision = 0 } = {}) {
  const memory = createDiscovery();
  memory.surveyed = new Set(cells);
  memory.gates = new Map(Object.entries(gates));
  memory.revision = revision;
  return { memory, knowledge: contestantKnowledge(memory, keys) };
}
const cellsWhere = test => Array.from({ length: COLS * ROWS }, (_, i) => i).filter(i => test(i % COLS, Math.floor(i / COLS)));
const everything = cellsWhere(() => true);

// The twins: identical in the left half, different beyond it. Twin B's hidden wall has no gap, so
// truth has no way east there, and it adds boxes, a void and a door; its obstacles come in another order.
const known = [box('crate', 400, 400, 100, 100), ...wallWithDoorway('w1', 960), box('pillar', 1500, 300, 60, 60)];
const knownDoor = door('d1', 960, 1152);
const twinA = field({ obstacles: [...known, box('far-n', 2994, 0, 12, 1000), box('far-s', 2994, 1300, 12, 1004)], gates: [knownDoor] });
const twinB = field({
  obstacles: [box('far', 2994, 0, 12, 2304), box('extra-1', 3400, 600, 200, 80), ...[...known].reverse(), box('extra-2', 4000, 1500, 90, 300)],
  gates: [door('hidden', 3600, 1152), knownDoor], voids: [[0, 18, 21], [1, 18, 21], [2, 18, 21]],
});
const leftHalf = cellsWhere(col => col < 12);

test('a tile depends only on the geometry within its reach, not on the obstacle order or anything beyond', () => {
  for (let col = 0; col < 11; col++) for (let row = 0; row < ROWS; row++) {
    const cell = { x: col * S, y: row * S, w: S, h: S };
    const [a, b] = [twinA, twinB].map(map => freeSpaceTile(map, cell, 14));
    assert.deepEqual([b.points, b.triangles, b.twins, b.gateSet, b.gateSets], [a.points, a.triangles, a.twins, a.gateSet, a.gateSets], `cell ${col},${row}`);
  }
  const doorway = freeSpaceTile(twinA, { x: 4 * S, y: 5 * S, w: S, h: S }, 14);
  assert.deepEqual(doorway.gateSets, [['d1']], 'the doorway tile marks the triangles the door decides');
});

test('a tile is known only when every cell its reach touches is: a partly supported tile is not', () => {
  const planner = createKnowledgePlanner(twinA, 'contestant');
  assert.deepEqual(planner.support(5 * COLS + 5).sort((a, b) => a - b), [4 * COLS + 4, 4 * COLS + 5, 4 * COLS + 6, 5 * COLS + 4, 5 * COLS + 5, 5 * COLS + 6, 6 * COLS + 4, 6 * COLS + 5, 6 * COLS + 6]);
  const block = planner.support(5 * COLS + 5);
  assert.ok(planner.tile(knowing(block).knowledge, 5 * COLS + 5));
  assert.equal(planner.tile(knowing(block.filter(c => c !== 6 * COLS + 6)).knowledge, 5 * COLS + 5), null, 'one corner cell short');
  // At the world's edge the support stops at the public bounds.
  assert.equal(planner.support(0).length, 4);
});

test('information test: twins identical in what a bot knows plan identically, though their truths differ', () => {
  const from = { x: 300, y: 1152 };
  const goals = [{ x: 1500, y: 600 }, { x: 4300, y: 1152 }, { x: 20.5 * S, y: 6.5 * S }, { x: 450, y: 450 }, { x: -5, y: 10 }, { x: 2700, y: 200 }];
  const beacon = 6 * COLS + 20;
  for (const gates of [{}, { d1: { open: true, locked: false } }, { d1: { open: false, locked: true } }]) for (const keys of [0, 1]) {
    const plans = [twinA, twinB].map(map => {
      const planner = createKnowledgePlanner(map, 'contestant'), { knowledge } = knowing([...leftHalf, beacon], { gates, keys });
      return goals.map(goal => planner.route(knowledge, from, goal)).concat([planner.route(knowledge, from, goals[1], 40)]);
    });
    assert.deepEqual(plans[1], plans[0], JSON.stringify({ gates, keys }));
  }
  const statuses = [twinA, twinB].map(map => createKnowledgePlanner(map, 'contestant').route(knowing(everything, { gates: { d1: { open: true, locked: false } } }).knowledge, from, { x: 4300, y: 1152 }).status);
  assert.deepEqual(statuses, ['complete', 'no-known-route'], 'the twins differ behind discovery');
});

test('information test through discovery: the same walk observes the same, so it plans the same', () => {
  const plans = [twinA, twinB].map(map => {
    const memory = createDiscovery(), planner = createKnowledgePlanner(map, 'contestant'), out = [];
    for (const eye of [{ x: 300, y: 1152 }, { x: 800, y: 1100 }, { x: 1300, y: 1152 }]) {
      discover(memory, map, eye, undefined, true);
      out.push(planner.route(contestantKnowledge(memory, 0), eye, { x: 4300, y: 1152 }));
    }
    return { out, surveyed: [...memory.surveyed].sort((a, b) => a - b), discovered: [...memory.discovered].sort((a, b) => a - b), gates: [...memory.gates], revision: memory.revision };
  });
  assert.deepEqual(plans[1], plans[0]);
  assert.deepEqual(plans[0].gates, [['d1', { open: false, locked: false }]], 'the door in sight is remembered as it stands');
});

test('with nothing known a route is a straight speculation, and the prefix is the start alone', () => {
  const route = createKnowledgePlanner(twinA, 'contestant').route(knowing([]).knowledge, { x: 300, y: 1152 }, { x: 4300, y: 1152 });
  assert.equal(route.status, 'speculative');
  assert.equal(route.length, 4000);
  assert.deepEqual(route.prefix, [{ x: 300, y: 1152 }]);
});

test('an isolated beacon is a disconnected fact: the route there is speculative from the frontier on', () => {
  const near = cellsWhere(col => col < 4), beacon = 6 * COLS + 20;
  const route = createKnowledgePlanner(twinA, 'contestant').route(knowing([...near, beacon]).knowledge, { x: 300, y: 1152 }, { x: 20.5 * S, y: 6.5 * S });
  assert.equal(route.status, 'speculative');
  // Known tiles are those whose whole support is known: columns 0 to 2. The prefix stops at their edge.
  assert.equal(route.prefix.at(-1).x, 3 * S);
  for (let i = 1; i < route.prefix.length; i++) assert.ok(sweptClear(twinA, route.prefix[i - 1], route.prefix[i], 14), 'the prefix is travelable');
});

test('doors are edge states: unobserved ones are optimistic, locked ones spend keys, one at a time', () => {
  const map = field({ obstacles: [...wallWithDoorway('w1', 960), ...wallWithDoorway('w2', 1920)], gates: [door('d1', 960, 1152), door('d2', 1920, 1152)] });
  const planner = createKnowledgePlanner(map, 'contestant'), from = { x: 300, y: 1152 }, to = { x: 2500, y: 1152 };
  const plan = (gates, keys = 0) => planner.route(knowing(everything, { gates, keys }).knowledge, from, to);
  const open = { open: true, locked: false }, shut = { open: false, locked: false }, locked = { open: false, locked: true };

  const unobserved = plan({});
  assert.equal(unobserved.status, 'speculative');
  assert.ok(unobserved.prefix.at(-1).x <= 960 - 6 - 14, 'the prefix stops short of the unobserved door');
  assert.equal(plan({ d1: open, d2: shut }).status, 'complete', 'a closed unlocked door is opened on the way');
  assert.equal(plan({ d1: locked, d2: open }).status, 'no-known-route');
  assert.deepEqual(plan({ d1: locked, d2: open }, 1).doors, ['d1']);
  assert.equal(plan({ d1: locked, d2: locked }, 1).status, 'no-known-route', 'one key opens one door');
  const both = plan({ d1: locked, d2: locked }, 2);
  assert.equal(both.status, 'complete');
  assert.deepEqual(both.doors, ['d1', 'd2']);
  // An unobserved lock past a known one: the key is spent and the tail stays speculative.
  const tail = plan({ d1: locked }, 1);
  assert.equal(tail.status, 'speculative');
  assert.deepEqual(tail.doors, ['d1']);
});

test('a stale door observation stands until the door is seen again, and the earlier route is then stale', () => {
  const map = field({ obstacles: wallWithDoorway('w1', 960), gates: [door('d1', 960, 1152, { open: true })] });
  const planner = createKnowledgePlanner(map, 'contestant'), from = { x: 300, y: 1152 }, to = { x: 1500, y: 1152 };
  const { memory } = knowing(everything, { gates: { d1: { open: false, locked: true } } });
  const before = planner.route(contestantKnowledge(memory, 0), from, to);
  assert.equal(before.status, 'no-known-route', 'it plans with the lock it saw, not the live door');
  discover(memory, map, { x: 800, y: 1152 }, undefined, true);
  assert.deepEqual(memory.gates.get('d1'), { open: true, locked: false });
  assert.equal(checkRoute(before, contestantKnowledge(memory, 0)).status, 'stale');
  assert.equal(planner.route(contestantKnowledge(memory, 0), from, to).status, 'complete');
  // Trying a door is an observation too.
  observeGate(memory, { id: 'd1', open: false, locked: true });
  assert.deepEqual(memory.gates.get('d1'), { open: false, locked: true });
});

test('known dead ends: a goal walled in on known ground has no route, but unknown ground keeps hope', () => {
  const room = [box('n', 1900, 900, 300, 12), box('s', 1900, 1300, 300, 12), box('w', 1900, 900, 12, 412), box('e', 2188, 900, 12, 412)];
  const map = field({ obstacles: room }), planner = createKnowledgePlanner(map, 'contestant');
  const from = { x: 300, y: 1152 }, inside = { x: 2050, y: 1100 };
  assert.equal(planner.route(knowing(everything).knowledge, from, inside).status, 'no-known-route');
  const hope = planner.route(knowing(cellsWhere(col => col < 11)).knowledge, from, inside);
  assert.equal(hope.status, 'speculative');
});

test('bots with different memories plan apart, and one\'s plan never changes the other\'s knowledge', () => {
  const map = field({ obstacles: wallWithDoorway('w1', 960), gates: [door('d1', 960, 1152, { locked: true })] });
  const planner = createKnowledgePlanner(map, 'contestant'), from = { x: 300, y: 1152 }, to = { x: 1500, y: 1152 };
  const first = knowing(everything, { gates: { d1: { open: false, locked: true } } }), second = knowing(everything);
  const before = structuredClone([...second.memory.gates]);
  assert.equal(planner.route(first.knowledge, from, to).status, 'no-known-route');
  assert.equal(planner.route(second.knowledge, from, to).status, 'speculative');
  assert.deepEqual([...second.memory.gates], before);
});

test('repeated invalidation: each discovery makes the last route stale, until the route is confirmed', () => {
  const memory = createDiscovery(), planner = createKnowledgePlanner(twinA, 'contestant'), goal = { x: 4300, y: 1152 };
  memory.gates = new Map([['d1', { open: true, locked: false }]]);
  let previous = null;
  const statuses = [];
  for (const eye of [{ x: 300, y: 1152 }, { x: 1500, y: 1152 }, { x: 2700, y: 1152 }, { x: 3900, y: 1152 }]) {
    discover(memory, twinA, eye, undefined, true);
    const knowledge = contestantKnowledge(memory, 0);
    if (previous) assert.equal(checkRoute(previous, knowledge).status, 'stale');
    previous = planner.route(knowledge, { x: 300, y: 1152 }, goal);
    assert.equal(checkRoute(previous, knowledge), previous, 'a fresh route is not stale');
    statuses.push(previous.status);
  }
  assert.deepEqual(statuses, ['speculative', 'speculative', 'speculative', 'complete']);
});

test('a budget is a count of expansions: exhausted, the search reports where it got, the same every time', () => {
  const planner = createKnowledgePlanner(twinA, 'contestant'), { knowledge } = knowing(everything, { gates: { d1: { open: true, locked: false } } });
  const runs = [0, 1].map(() => planner.route(knowledge, { x: 300, y: 1152 }, { x: 4300, y: 1152 }, 30));
  assert.equal(runs[0].status, 'budget-exhausted');
  assert.ok(runs[0].points.length >= 2);
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(planner.route(knowledge, { x: 300, y: 1152 }, { x: 4300, y: 1152 }).status, 'complete', 'a budget failure is not unreachability');
});

test('a search advanced a slice at a time expands the same places and returns the same route as one run whole (#470)', () => {
  const planner = createKnowledgePlanner(twinA, 'contestant'), from = { x: 300, y: 1152 }, to = { x: 4300, y: 1152 };
  for (const [known, budget] of [[everything, undefined], [cellsWhere(col => col < 11), undefined], [everything, 30]]) {
    const { knowledge } = knowing(known, { gates: { d1: { open: true, locked: false } } });
    const whole = planner.route(knowledge, from, to, budget), search = planner.search(knowledge, from, to, budget);
    let sliced = null, slices = 0;
    while (!(sliced = search.advance(7))) slices++;
    assert.ok(slices > 0, 'the search spanned several slices');
    assert.deepEqual(sliced, whole);
    assert.equal(search.advance(7), sliced, 'an ended search keeps its route');
  }
});

test('frozen knowledge keeps the cells and doors known when it was taken', () => {
  const memory = createDiscovery();
  discover(memory, twinA, { x: 300, y: 1152 }, undefined, true);
  // A door the map does not have, so discovery leaves its observation alone.
  memory.gates.set('x1', { open: false, locked: true });
  const live = contestantKnowledge(memory, 1), frozen = frozenKnowledge(live, COLS * ROWS, ['x1', 'x2']), before = [...memory.discovered];
  discover(memory, twinA, { x: 2700, y: 1152 }, undefined, true);
  memory.gates.set('x1', { open: true, locked: false });
  const cells = Array.from({ length: COLS * ROWS }, (_, cell) => cell);
  assert.ok(cells.some(cell => live.known(cell) && !frozen.known(cell)), 'the live knowledge grew');
  assert.ok(before.every(cell => frozen.known(cell)));
  assert.deepEqual([frozen.door('x1'), frozen.door('x2'), frozen.keys], [{ open: false, locked: true }, undefined, 1]);
});

test('information test on a live map: obstacles out of every known cell, removed or reordered, change nothing', () => {
  const map = generateLiveMap(7), { cols } = discoveryGrid(map), memory = createDiscovery();
  const spawn = map.spawns[0];
  for (let i = 0; i < 4; i++) discover(memory, map, { x: spawn.x + i * 900, y: spawn.y }, undefined, true);
  const knownCell = cell => memory.discovered.has(cell) || memory.surveyed.has(cell);
  const touchesKnown = o => {
    const b = bounds(shapeOf(o));
    for (let row = Math.floor(b.y / S); row <= Math.floor((b.y + b.h) / S); row++)
      for (let col = Math.floor(b.x / S); col <= Math.floor((b.x + b.w) / S); col++) if (knownCell(row * cols + col)) return true;
    return false;
  };
  const twin = { ...map, obstacles: map.obstacles.filter(touchesKnown).reverse() };
  assert.ok(twin.obstacles.length < map.obstacles.length / 2, 'most of the map is hidden, and differs');
  const goals = [map.exit, ...map.chargers.slice(0, 3), { x: spawn.x + 2000, y: spawn.y + 300 }];
  const plans = [map, twin].map(m => {
    const planner = createKnowledgePlanner(m, 'contestant');
    return goals.map(goal => planner.route(contestantKnowledge(memory, 0), spawn, goal));
  });
  assert.deepEqual(plans[1], plans[0]);
  assert.ok(plans[0].some(route => route.tiles > 20), 'the plans read known ground');
});

test('tiles packed on one copy of a map and adopted by another are the tiles it would build, and plan the same', () => {
  // Doors, so some tiles carry gate sets; a wall, so triangles vary. The worker packs a gladiator's (22.6, "Bot adoption").
  const map = field({ obstacles: wallWithDoorway('w', 12 * S), gates: [door('d', 12 * S - 6, 1104, { locked: true })] });
  const packed = structuredClone(packedTilesFor(map, 'gladiator')), adopted = structuredClone(map), built = structuredClone(map);
  adoptPackedTiles(adopted, packed);
  const { cols, rows, size } = discoveryGrid(map);
  for (let cell = 0; cell < cols * rows; cell++) {
    const box = { x: (cell % cols) * size, y: Math.floor(cell / cols) * size, w: size, h: size };
    const tile = freeSpaceTile(adopted, box, 25);
    assert.equal(tile.points.buffer, packed.floats.buffer, `cell ${cell} is read from the packed tiles`);
    assert.deepEqual(tile, freeSpaceTile(built, box, 25), `cell ${cell}`);
  }
  assert.ok(freeSpaceTile(adopted, { x: 0, y: 0, w: S, h: S }, 14).points.buffer !== packed.floats.buffer, 'another body builds its own');
  const all = { known: () => true, door: () => ({ open: false, locked: true }), keys: 1, revision: 0 };
  const [a, b] = [adopted, built].map(m => createKnowledgePlanner(m, 'gladiator').route(all, { x: 300, y: 300 }, { x: 4300, y: 2000 }));
  assert.equal(a.status, 'complete'); assert.deepEqual(a, b);
});
