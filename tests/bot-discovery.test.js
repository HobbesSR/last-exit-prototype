import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView } from '../shared/simulation.ts';
import { botInput, joinRoute, passed } from '../shared/simulation/bots.ts';
import { canOccupy, movePlayer, sweptClear } from '../shared/movement.ts';
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

for (const content of ['content-2', 'content-3', 'content-4']) test(`a bot enters a reachable roofed frontier cell rather than giving it up from outside (#354 review, ${content})`, () => {
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
for (const [content, alike] of [['content-5', true], ['content-4', true], ['content-3', true], ['content-2', false]]) test(`information test: over tiles, a bot's targets, routes and inputs depend only on what it knows (${content})`, () => {
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

test('a route that arrives late is joined only within its clearance margin, else by the trail back (#473 review)', () => {
  const playableArea = { cellSize: 200, rows: Array.from({ length: 6 }, (_, y) => ({ y, runs: [[0, 6]] })) };
  const map = { width: 1200, height: 1200, playableArea, obstacles: [{ id: 'wall', x: 200, y: 300, w: 100, h: 300 }], gates: [], buildings: [], items: [] };
  const clear = (bot, way) => way.every((point, i) => sweptClear(map, i ? way[i - 1] : bot, point, 12));
  const contestant = (x, y) => ({ role: 'contestant', x, y });

  // The bot walked round the wall while its search ran: the nearest segment lies beyond it.
  const round = [{ x: 100, y: 100 }, { x: 180, y: 620 }, { x: 400, y: 900 }], far = contestant(400, 100);
  assert.ok(clear(round[0], round.slice(1)), 'the planned legs are clear');
  const back = joinRoute(far, round, [{ x: 100, y: 100 }, { x: 250, y: 100 }, { x: 400, y: 100 }]);
  assert.deepEqual(back.slice(0, 3), [{ x: 400, y: 100 }, { x: 250, y: 100 }, { x: 100, y: 100 }], 'it walks back the way it came');
  assert.ok(clear(far, back));

  // Beside a segment along the wall, 10 units off it: the diagonal to its end would meet the wall.
  const along = [{ x: 186, y: 100 }, { x: 186, y: 900 }], beside = contestant(196, 100);
  assert.ok(clear(along[0], along.slice(1)) && !clear(beside, along.slice(1)));
  const stepped = joinRoute(beside, along, [{ x: 186, y: 100 }, { x: 196, y: 100 }]);
  assert.deepEqual(stepped, [{ x: 196, y: 100 }, ...along]);
  assert.ok(clear(beside, stepped));

  // Within the margin the planner keeps beyond the body, it joins where it is.
  const close = contestant(187.5, 100), joined = joinRoute(close, along, [{ x: 186, y: 100 }, { x: 187.5, y: 100 }]);
  assert.deepEqual(joined, along.slice(1));
  assert.ok(clear(close, joined));
  assert.deepEqual(joinRoute(contestant(140, 360), round, [{ x: 100, y: 100 }, { x: 140, y: 360 }]), round.slice(1), 'on the route');
});

test('under sliced replanning a bot turns short of a waypoint only within the margin of the next leg (#473 review)', () => {
  const playableArea = { cellSize: 200, rows: Array.from({ length: 6 }, (_, y) => ({ y, runs: [[0, 6]] })) };
  const map = { width: 1200, height: 1200, playableArea, obstacles: [{ id: 'wall', x: 200, y: 300, w: 100, h: 300 }], gates: [], buildings: [], items: [] };
  const game = content => ({ map, content: contentById(content) }), corner = { x: 186, y: 100 }, end = { x: 186, y: 900 };
  // 10 units off a leg along the wall, the first 24 units toward its end are clear but the rest is not.
  const beside = { role: 'contestant', x: 196, y: 100 };
  assert.equal(passed(game('content-3'), beside, corner, end), true, 'content-3 keeps its rule');
  assert.equal(passed(game('content-4'), beside, corner, end), false);
  assert.equal(passed(game('content-4'), { role: 'contestant', x: 187.5, y: 100 }, corner, end), true);
});

test('under content-5 a door seen opening near a bot reroutes it at once, and one further off at its next repath (#470 part 2)', () => {
  // A wall at x 600–640 with a door in it, and a gap at its foot. The bot saw the door locked, so it
  // routes through the gap; then the door is seen open.
  const cell = { id: 'cell', kind: 'cell', x: 1100, y: 330, charge: 0 };
  const map = { ...openMap([cell]), nodes: [], streets: [], hazards: [], traps: [], chargers: [], stations: [], exit: { x: 1800, y: 100 },
    obstacles: [{ id: 'upper', x: 600, y: 0, w: 40, h: 300 }, { id: 'lower', x: 600, y: 360, w: 40, h: 440 }],
    gates: [{ id: 'door', x: 620, y: 330, w: 40, h: 60, open: true, locked: false, kind: 'door' }] };
  const run = (content, x, y) => {
    const p = { id: 'c0', name: 'contestant-1', role: 'contestant', kit: 'warden', bot: true, x, y, hp: 100, maxHp: 100, shield: 0, keys: 0,
      weapon: 0, kills: 0, level: 1, status: 'active', cooldown: 0, attackCd: 0, railCd: 0, cloak: 0, revealed: 0, boost: 0, stun: 0, heading: 0,
      input: {}, lastSeq: -1, inventory: Array(4).fill(null), selectedSlot: 0, path: [] };
    const memory = createDiscovery();
    memory.seen = new Set();
    for (let i = 0; i < 50; i++) { memory.discovered.add(i); memory.seen.add(i); }
    memory.items = new Map([[cell.id, { ...cell }]]);
    memory.gates = new Map([['door', { open: false, locked: true }]]);
    attachDiscovery(p, memory);
    const s = { tick: 0, phase: 'live', content: contentById(content), map, players: [p], projectiles: [], effects: [], events: [], hazardX: -80, slots: 3, serial: 0 };
    const through = () => !p.route.some(q => q.y >= 800);
    // The bot stands still, so only what it knows changes.
    for (; s.tick < 60 && !p.route?.length; s.tick++) botInput(s, p);
    assert.ok(p.route.length && !through(), 'it routes round by the gap: ' + JSON.stringify(p.route));
    for (; s.tick % 20 !== 1; s.tick++) botInput(s, p);
    memory.gates.set('door', { open: true, locked: false });
    const seenAt = s.tick;
    for (; s.tick < seenAt + 40 && !through(); s.tick++) botInput(s, p);
    assert.ok(through(), `it takes the door in the end (${content}): ${JSON.stringify(p.route)}`);
    return s.tick - seenAt;
  };
  assert.equal(run('content-5', 420, 330), 1, 'near: repaired on the tick it is seen');
  assert.ok(run('content-4', 420, 330) >= 19, 'content-4 waits for its turn');
  const later = run('content-5', 100, 330);
  assert.ok(later >= 19, `further off: at its next repath, not after ${later}`);
});
