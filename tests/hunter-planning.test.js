import test from 'node:test';
import assert from 'node:assert/strict';
import { botInput } from '../shared/simulation/bots.ts';
import { attachPortalGraph } from '../shared/navigation/portal-graph.ts';
import { contentById } from '../shared/simulation/content.ts';
import * as profiler from '../shared/profiler.ts';

// Under `hunterPlanning: 'portals'` a gladiator plans a trip across regions a leg at a time (#682, 22.6).

const CELL = 192, REGIONS = 4, WIDTH = 4 * CELL, HEIGHT = 3 * CELL;

/** Four regions side by side, walled from each other except for one gap each, with the exit in the last. */
function corridorMap() {
  const playableArea = { cellSize: CELL, rows: Array.from({ length: 3 }, (_, y) => ({ y, runs: [[0, 4 * REGIONS]] })) };
  // Each wall leaves a gap at y 0–192, 192–384 or 384–576 in turn, so a trip zigzags.
  const gaps = [0, 2, 0], obstacles = [], joins = [];
  gaps.forEach((gap, i) => {
    const x = (i + 1) * WIDTH - 20;
    for (let row = 0; row < 3; row++) if (row !== gap) obstacles.push({ id: `wall-${i}-${row}`, x, y: row * CELL, w: 40, h: CELL });
    joins.push({ a: i, b: i + 1, x: x + 20, y: gap * CELL + CELL / 2 });
  });
  const map = { width: REGIONS * WIDTH, height: HEIGHT, playableArea, obstacles, gates: [], buildings: [], items: [], nodes: [], streets: [], hazards: [],
    traps: [], chargers: [], stations: [], exit: { x: REGIONS * WIDTH - 96, y: HEIGHT / 2 } };
  const cols = REGIONS * 4, owner = new Int32Array(cols * 3);
  for (let row = 0; row < 3; row++) for (let col = 0; col < cols; col++) owner[row * cols + col] = Math.floor(col / 4);
  const regions = Array.from({ length: REGIONS }, (_, i) => ({ id: `r${i}`, box: { x: i * WIDTH, y: 0, w: WIDTH, h: HEIGHT }, portals: [] }));
  const portals = joins.map(({ a, b, x, y }, node) => ({ id: `p${node}`, x, y, stands: [], regions: [a, b],
    slots: [regions[a].portals.push(node) - 1, regions[b].portals.push(node) - 1] }));
  attachPortalGraph(map, { cellSize: CELL, cols, rows: 3, owner, regions, portals });
  return { map, crossings: joins.map(({ x, y }) => ({ x, y })) };
}

function hunterScene(contentId, planning) {
  const { map, crossings } = corridorMap();
  const content = planning ? { ...contentById(contentId), hunterPlanning: planning } : contentById(contentId);
  const p = { id: 'g0', name: 'hunter', role: 'gladiator', kit: 'warden', bot: true, x: 300, y: 480, hp: 360, maxHp: 360, shield: 0, keys: 0,
    weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0,
    input: {}, lastSeq: -1, path: [] };
  const s = { tick: 0, phase: 'live', content, map, players: [p], projectiles: [], effects: [], events: [], hazardX: -80, slots: 3, serial: 0 };
  return { s, p, crossings };
}

/** Run the bot until it has a route, without moving it. */
function firstRoute({ s, p }) {
  for (; s.tick < 200 && !p.route?.length; s.tick++) { botInput(s, p); profiler.frame(); }
  return p.route;
}

test('a gladiator plans only as far as the crossing after next, then on to the goal', () => {
  const scene = hunterScene('content-5', 'portals'), { s, p, crossings } = scene;
  const route = firstRoute(scene);
  assert.ok(route?.length, 'it plans');
  assert.deepEqual(route.at(-1), crossings[1], 'the first leg ends at the second crossing');
  // Standing in the third region, the next crossing leads into the goal's region, so the leg is the trip's end.
  p.x = 2 * WIDTH + 200; p.y = 480; p.route = [];
  for (const end = s.tick + 40; s.tick < end && !(p.route?.length && p.route.at(-1).x === s.map.exit.x); s.tick++) botInput(s, p);
  assert.deepEqual(p.route.at(-1), s.map.exit, 'it plans to the exit');
});

test('without the setting, or on a map without a portal graph, a gladiator plans the whole way', () => {
  const scene = hunterScene('content-5');
  assert.deepEqual(firstRoute(scene).at(-1), scene.s.map.exit);
  const bare = hunterScene('content-5', 'portals');
  bare.s.map = { ...bare.s.map };
  assert.deepEqual(firstRoute(bare).at(-1), bare.s.map.exit, 'a copied map carries no graph');
});

test('a leg searches less than the whole trip', () => {
  const expansions = planning => {
    const scene = hunterScene('content-5', planning);
    profiler.reset(); profiler.enable(true);
    firstRoute(scene);
    const row = profiler.report().find(r => r.name === 'work.route.expansions');
    profiler.enable(false);
    return Math.round(row.mean * row.samples);
  };
  const whole = expansions(undefined), leg = expansions('portals');
  assert.ok(leg < whole, `leg ${leg} against whole ${whole}`);
});

test('content-7 is content-6 with gladiators planning over the portal graph', () => {
  const { id, hunterPlanning, ...seven } = contentById('content-7'), { id: six, ...rest } = contentById('content-6');
  assert.deepEqual([id, six, hunterPlanning, seven], ['content-7', 'content-6', 'portals', rest]);
});
