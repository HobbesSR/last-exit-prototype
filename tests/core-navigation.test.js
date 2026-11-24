import test from 'node:test';
import assert from 'node:assert/strict';
import { initCore } from '../shared/core.ts';
import { contestantKnowledge, createKnowledgePlanner, ROUTE_BUDGET } from '../shared/navigation/knowledge.ts';
import { createDiscovery } from '../shared/discovery.ts';
import { navigationClearance } from '../shared/map/navigation.ts';
import { packRuntimeMap, unpackMap } from '../server/map-pack.js';
import { prepareRuntimeNavigation } from '../server/runtime-map.js';
import { legGoal, abandonLeg } from '../shared/simulation/bot-routes.ts';
import { arena } from './helpers/arena.js';

const S = 192, COLS = 24, ROWS = 12;
const box = (id, x, y, w, h) => ({ id, kind: 'wall', x, y, w, h });
const door = (id, x) => ({ id, kind: 'door', x, y: 1152, w: 12, h: 96, open: false, locked: false });
const wall = (id, x) => [box(`${id}-n`, x - 6, 0, 12, 1104), box(`${id}-s`, x - 6, 1200, 12, 1104)];
function field(obstacles, gates, voids = false) {
  const rows = Array.from({ length: ROWS }, (_, y) => ({ y, runs: voids && y < 3 ? [[0, 18], [21, COLS]] : [[0, COLS]] }));
  return { width: COLS * S, height: ROWS * S, playableArea: { cellSize: S, rows }, obstacles, gates, buildings: [] };
}
const common = [box('crate', 400, 400, 100, 100), ...wall('w1', 960), box('pillar', 1500, 300, 60, 60)];
const twins = [
  field([...common, box('far-n', 2994, 0, 12, 1000), box('far-s', 2994, 1300, 12, 1004)], [door('d1', 960)]),
  field([box('far', 2994, 0, 12, 2304), box('extra-1', 3400, 600, 200, 80), ...[...common].reverse(), box('extra-2', 4000, 1500, 90, 300)], [door('hidden', 3600), door('d1', 960)], true),
];
const cells = Array.from({ length: COLS * ROWS }, (_, i) => i);
const left = cells.filter(i => i % COLS < 12);
const from = { x: 300, y: 1152 }, goal = { x: 4300, y: 1152 };
const statuses = ['complete', 'speculative', 'no-known-route', 'invalid-endpoint', 'budget-exhausted'];

function knowledge(cellsKnown, gates, keys, revision) {
  const memory = createDiscovery();
  memory.surveyed = new Set(cellsKnown);
  memory.gates = new Map(Object.entries(gates));
  memory.revision = revision;
  return contestantKnowledge(memory, keys);
}

function readRoute(core, handle, map) {
  const count = core.core_route_output_len(handle);
  if (!count) return null;
  const words = Array.from(new Float64Array(core.memory.buffer, core.core_route_output(handle), count));
  const [status, length, expansions, tiles, revision, keys, pointCount, prefixCount, doorCount] = words;
  let at = 9;
  const points = n => Array.from({ length: n }, () => ({ x: words[at++], y: words[at++] }));
  const route = { status: statuses[status], points: points(pointCount), length, prefix: points(prefixCount),
    doors: words.slice(at, at + doorCount).map(slot => map.gates[slot].id), expansions, tiles, revision, keys };
  assert.equal(at + doorCount, count);
  return route;
}

function compare(core, pointer, map, role, known, start, end, budget = ROUTE_BUDGET) {
  const input = new Uint8Array(cells.length + map.gates.length);
  for (const cell of cells) input[cell] = Number(known.known(cell));
  map.gates.forEach((gate, slot) => {
    const state = known.door(gate.id);
    input[cells.length + slot] = !state ? 0 : state.open ? 3 : state.locked ? 2 : 1;
  });
  const bytes = core.core_alloc(input.length);
  assert.ok(bytes);
  new Uint8Array(core.memory.buffer, bytes, input.length).set(input);
  let handle = 0;
  try {
    handle = core.core_route_start(pointer, navigationClearance(role), start.x, start.y, end.x, end.y,
      budget, known.keys, known.revision, bytes, input.length);
    assert.ok(handle);
    const search = createKnowledgePlanner(map, role).search(known, start, end, budget);
    let expected, actual;
    do {
      expected = search.advance(7);
      assert.equal(core.core_route_advance(handle, 7), search.expansions, 'expansions at slice boundary');
      actual = readRoute(core, handle, map);
      assert.equal(actual === null, expected === null, 'completion at slice boundary');
    } while (!expected);
    assert.deepEqual(actual, expected);
    return actual;
  } finally {
    if (handle) core.core_route_free(handle);
    core.core_free(bytes, input.length);
  }
}

test('Rust knowledge search matches the JS information witness and sliced results', async () => {
  const core = await initCore();
  for (const deferContestant of [false, true]) {
    const maps = twins.map(map => unpackMap(packRuntimeMap(map, { deferContestant })));
    const prepared = [];
    try {
      for (const map of maps) prepared.push(await prepareRuntimeNavigation(map));
      for (const role of ['contestant', 'gladiator']) {
        for (const gates of [{}, { d1: { open: true, locked: false } }, { d1: { open: false, locked: false } }, { d1: { open: false, locked: true } }]) {
          for (const keys of [0, 1]) {
            const known = knowledge([...left, 6 * COLS + 20], gates, keys, 17);
            const routes = twins.map((map, i) => compare(core, prepared[i].pointer, map, role, known, from, goal));
            assert.deepEqual(routes[0], routes[1], 'hidden differences cannot affect the route');
            if (gates.d1?.locked && keys === 1) assert.deepEqual(routes[0].doors, ['d1']);
          }
        }
        const observed = knowledge(cells, { d1: { open: true, locked: false } }, 0, 18);
        const surveyed = twins.map((map, i) => compare(core, prepared[i].pointer, map, role, observed, from, goal));
        assert.deepEqual(surveyed.map(route => route.status), ['complete', 'no-known-route']);
        for (const [start, end, budget] of [[from, goal, 0], [from, goal, 30], [from, from, ROUTE_BUDGET], [from, { x: -5, y: 10 }, ROUTE_BUDGET], [from, { x: 450, y: 450 }, ROUTE_BUDGET]]) {
          compare(core, prepared[0].pointer, twins[0], role, observed, start, end, budget);
        }
      }
    } finally {
      for (const item of prepared) item.release();
    }
  }
});

test('Rust corridor legs follow the JS cached portal corridor', async () => {
  const core = await initCore();
  for (const graph of [true, false]) {
    const { map: source, crossings } = arena({ cols: 16, rows: 6, ...(graph ? { corridor: { gaps: [1, 4, 2] } } : {}) });
    const map = unpackMap(packRuntimeMap(source));
    const { pointer, release } = await prepareRuntimeNavigation(map);
    const corridor = core.core_corridor_new(pointer);
    const output = core.core_alloc(16);
    assert.ok(corridor);
    assert.ok(output);
    const player = { x: 200, y: 300 };
    const game = { map: source };
    const compareLeg = target => {
      const expected = legGoal(game, player, target);
      core.core_corridor_leg(corridor, player.x, player.y, target.x, target.y, output);
      const [x, y] = new Float64Array(core.memory.buffer, output, 2);
      assert.deepEqual({ x, y }, expected);
      return expected;
    };
    try {
      const target = { x: 2900, y: 900 };
      const first = compareLeg(target);
      if (graph) assert.deepEqual(first, crossings[1], 'the first leg ends at the second crossing');
      player.x = 950;
      compareLeg(target);
      abandonLeg(player);
      core.core_corridor_abandon(corridor);
      assert.deepEqual(compareLeg(target), target);
      const changedRegion = { x: 1800, y: 300 };
      compareLeg(changedRegion);
      player.x = 1800;
      compareLeg(changedRegion);
      compareLeg({ x: -1, y: 0 });
    } finally {
      core.core_free(output, 16);
      core.core_corridor_free(corridor);
      release();
    }
  }
});
