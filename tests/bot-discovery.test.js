import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView } from '../shared/simulation.ts';
import { botInput } from '../shared/simulation/bots.ts';
import { canOccupy, movePlayer } from '../shared/movement.ts';
import { createDiscovery, discover, attachDiscovery, discoveryGrid, DISCOVERY_INTERVAL, DISCOVERY_RADIUS } from '../shared/discovery.ts';
import { bounds, shapeOf } from '../shared/shape.ts';
import { contentById } from '../shared/simulation/content.ts';
import { generateLiveMap } from '../map/live.ts';

// Contestant bots know what they have discovered, like people (15, #230).

function openMap(items, buildings = []) {
  const playableArea = { cellSize: 192, rows: Array.from({ length: 5 }, (_, y) => ({ y, runs: [[0, 10]] })) };
  return { width: 1920, height: 960, playableArea, obstacles: [], gates: [], buildings, items };
}

test('the sight that discovers cells remembers the items it sees, not ones under a roof', () => {
  const building = { id: 'b1', nodeId: 'node-1', x: 384, y: 192, w: 192, h: 192 };
  const map = openMap([{ id: 'in-view', kind: 'cell', x: 200, y: 320 }, { id: 'roofed', kind: 'cell', x: 480, y: 288 }], [building]);
  const memory = createDiscovery();
  discover(memory, map, { x: 200, y: 200 });
  assert.equal(memory.items, undefined, 'only bots keep item memory');
  discover(memory, map, { x: 200, y: 200 }, undefined, true);
  assert.deepEqual([...memory.items.keys()], ['in-view']);
});

test('a remembered item is forgotten once its spot is seen empty, and kept while out of sight', () => {
  const building = { id: 'b1', nodeId: 'node-1', x: 384, y: 192, w: 192, h: 192 };
  const map = openMap([], [building]);
  const memory = createDiscovery();
  memory.items = new Map([['taken', { id: 'taken', kind: 'cell', x: 200, y: 320 }], ['roofed', { id: 'roofed', kind: 'cell', x: 480, y: 288 }]]);
  discover(memory, map, { x: 200, y: 200 }, undefined, true);
  assert.deepEqual([...memory.items.keys()], ['roofed']);
});

// A live chain map, as rooms play: no street-block graph, so a route runs to its target.
let liveMap;
function lone(seed = 4217) {
  liveMap ??= generateLiveMap(seed);
  const s = createGame(seed, structuredClone(liveMap));
  for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.traps = []; s.map.items = [];
  for (const p of s.players) p.discovery?.items?.clear();
  const p = s.players[0]; p.bot = true;
  return { s, p };
}
// Plan afresh until a route exists: a frontier cell that cannot be routed to is given up, and the next
// tried. A first plan waits for the bot's turn, so the clock runs.
function plan(s, p) {
  for (let i = 0; i < 40 && !p.route?.length; i++) { p.route = []; botInput(s, p); s.tick++; }
  return p.route.at(-1);
}

test('a bot routes to a cell it has seen and not to one it has not', () => {
  const { s, p } = lone();
  let spot;
  for (let r = 2600; !spot && r < 4000; r += 200)
    for (let a = 0; a < 16 && !spot; a++) {
      const x = p.x + Math.cos(a * Math.PI / 8) * r, y = p.y + Math.sin(a * Math.PI / 8) * r;
      if (x > 300 && canOccupy(s.map, x, y, 25)) spot = { x, y };
    }
  assert.ok(spot, 'an open spot far from the bot');
  const cell = { id: 'far-cell', kind: 'cell', ...spot };
  s.map.items = [cell];

  p.route = [];
  const unknown = plan(s, p);
  assert.ok(Math.hypot(unknown.x - spot.x, unknown.y - spot.y) > 500, 'an unseen cell is not a destination');

  p.discovery.items.set(cell.id, { ...cell });
  p.route = [];
  const known = plan(s, p);
  assert.ok(Math.hypot(known.x - spot.x, known.y - spot.y) < 150, 'a seen cell is');
});

test('a bot that knows of nothing it needs explores', () => {
  const { s, p } = lone();
  const start = { x: p.x, y: p.y }, before = p.discovery.discovered.size;
  for (let i = 0; i < 300; i++) step(s);
  assert.ok(p.discovery.discovered.size > before + 10, `discovered ${before} → ${p.discovery.discovered.size}`);
  assert.ok(Math.hypot(p.x - start.x, p.y - start.y) > 500, 'it went looking');
});

test('item, door and survey memory stay out of snapshots and every projection', () => {
  const { s, p } = lone();
  p.discovery.items.set('remembered-cell', { id: 'remembered-cell', kind: 'cell', x: p.x + 5000, y: p.y });
  // Door observations and surveyed cells, which navigation's knowledge filter reads (22.6, #423), stay private too.
  p.discovery.gates = new Map([['remembered-door', { open: false, locked: true }]]);
  p.discovery.surveyed = new Set([1, 2, 3]);
  const frame = snapshot(s);
  for (const secret of ['remembered-cell', 'remembered-door', 'surveyed', 'revision']) {
    assert.equal(JSON.stringify(frame).includes(secret), false, secret);
    for (const viewer of s.players) assert.equal(JSON.stringify(playerView(s, frame, viewer.id)).includes(secret), false, viewer.id);
  }
});

for (const content of ['content-2', 'content-3']) test(`a bot enters a reachable roofed frontier cell rather than giving it up from outside (#354 review, ${content})`, () => {
  // Open ground with one roofed room. Everything has been seen but the room's cell, index 84, whose centre
  // (864, 1632) stays concealed until the bot stands under the roof. The room holds the only cell.
  const cell = { id: 'indoor-cell', kind: 'cell', x: 864, y: 1632, charge: 0 };
  const map = { width: 1920, height: 3840, nodes: [], streets: [], obstacles: [], gates: [], hazards: [], traps: [],
    buildings: [{ id: 'room', x: 768, y: 1536, w: 192, h: 192 }], items: [cell], chargers: [], stations: [], exit: { x: 1800, y: 100 } };
  assert.ok(canOccupy(map, cell.x, cell.y, 14), 'the room is walkable');
  const p = { id: 'c0', name: 'contestant-1', role: 'contestant', kit: 'warden', bot: true, x: 576, y: 1632, hp: 100, maxHp: 100, shield: 0, keys: 0,
    weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0,
    input: {}, lastSeq: -1, inventory: Array(4).fill(null), selectedSlot: 0, path: [] };
  const memory = createDiscovery();
  memory.seen = new Set();
  for (let i = 0; i < 200; i++) { memory.discovered.add(i); if (i !== 84) memory.seen.add(i); }
  attachDiscovery(p, memory);
  const s = { tick: 0, phase: 'live', content: contentById(content), map, players: [p], projectiles: [], effects: [], events: [], hazardX: -80, slots: 3, serial: 0 };
  for (; s.tick < 400 && !memory.seen.has(84); s.tick++) {
    movePlayer(map, p, botInput(s, p));
    if (s.tick % DISCOVERY_INTERVAL === 0) discover(memory, map, p, undefined, true);
  }
  assert.ok(memory.seen.has(84), 'the roofed cell is seen by going in');
  assert.ok(memory.items.has('indoor-cell'), 'and the cell inside is seen');
});

// The bot-level information test (22.6, #424): a contestant planning over tiles chooses its targets,
// ranks them, judges ground and doors and steers from what it knows. Run a bot on a live map, then on
// a twin that agrees wherever it looked and has nothing beyond: no obstacles or doors, and no ground.
// The two walks must match tick for tick. The bot remembers a cell far across unseen ground,
// so its route runs where the twins differ; the grid planner, which reads the truth, parts.
for (const [content, alike] of [['content-3', true], ['content-2', false]]) test(`information test: over tiles, a bot's targets, routes and inputs depend only on what it knows (${content})`, () => {
  const seed = 4217;
  liveMap ??= generateLiveMap(seed);
  const spawn = liveMap.spawns[0], far = { id: 'far-cell', kind: 'cell', x: spawn.x + 6000, y: spawn.y, charge: 0 };
  for (let dy = 48; !canOccupy(liveMap, far.x, far.y, 25); dy += 48) far.y = spawn.y + (dy % 96 ? dy : -dy);
  const walk = map => {
    const s = createGame(seed, structuredClone(map), contentById(content));
    for (const p of s.players) if (p.id !== 'c0') { p.bot = false; p.input = {}; }
    s.map.traps = []; s.map.items = [];
    const p = s.players[0], trace = [], eyes = [];
    p.discovery.items.clear(); p.discovery.items.set(far.id, { ...far });
    for (let i = 0; i < 500; i++) {
      step(s);
      trace.push(JSON.stringify([p.x, p.y, p.heading, p.route, p.inventory]));
      eyes.push({ x: p.x, y: p.y });
    }
    return { trace, eyes, memory: p.discovery, s };
  };
  const truth = walk(liveMap);
  const { cols, size } = discoveryGrid(liveMap), memory = truth.memory;
  // What the bot could have read: cells it knows, and anything within sight of where it looked.
  const known = cell => memory.discovered.has(cell) || memory.surveyed.has(cell);
  const sighted = box => truth.eyes.some(e => Math.hypot(Math.max(box.x, Math.min(box.x + box.w, e.x)) - e.x, Math.max(box.y, Math.min(box.y + box.h, e.y)) - e.y) <= DISCOVERY_RADIUS + 1);
  const touchesKnown = box => {
    for (let row = Math.floor(box.y / size); row <= Math.floor((box.y + box.h) / size); row++)
      for (let col = Math.floor(box.x / size); col <= Math.floor((box.x + box.w) / size); col++) if (known(row * cols + col)) return true;
    return false;
  };
  const kept = box => touchesKnown(box) || sighted(box);
  // The playable area's own cells, which are finer than discovery's.
  const area = liveMap.playableArea, unit = area.cellSize;
  const rows = area.rows.map(({ y, runs: truthRuns }) => {
    const runs = [];
    for (const [a, b] of truthRuns) for (let col = a; col < b; col++) {
      if (!kept({ x: col * unit, y: y * unit, w: unit, h: unit })) continue;
      if (runs.at(-1)?.[1] === col) runs.at(-1)[1] = col + 1; else runs.push([col, col + 1]);
    }
    return { y, runs };
  });
  const twin = { ...liveMap, playableArea: { ...area, rows }, obstacles: liveMap.obstacles.filter(o => kept(bounds(shapeOf(o)))).reverse(), gates: liveMap.gates.filter(g => kept(g)) };
  assert.ok(twin.obstacles.length < liveMap.obstacles.length / 2, 'most of the map differs');
  const cells = list => list.reduce((n, r) => n + r.runs.reduce((m, [a, b]) => m + b - a, 0), 0);
  assert.ok(cells(rows) < cells(area.rows) / 2, 'ground the bot never saw is void');
  const other = walk(twin);
  const first = other.trace.findIndex((t, i) => t !== truth.trace[i]);
  if (!alike) return assert.ok(first >= 0, 'the grid planner reads the truth, so its walk parts');
  assert.equal(first, -1, `the walks part at tick ${first + 1}: ${truth.trace[first]?.slice(0, 300)} vs ${other.trace[first]?.slice(0, 300)}`);
  assert.ok(Math.hypot(truth.s.players[0].x - spawn.x, truth.s.players[0].y - spawn.y) > 1000, 'the bot went a long way');
});
