import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView } from '../shared/simulation.ts';
import { botInput } from '../shared/simulation/bots.ts';
import { canOccupy, movePlayer, TILE } from '../shared/movement.ts';
import { createDiscovery, discover, attachDiscovery, DISCOVERY_INTERVAL } from '../shared/discovery.ts';
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
// Plan afresh until a route exists: a frontier cell that cannot be routed to is given up, and the next tried.
function plan(s, p) {
  for (let i = 0; i < 20 && !p.path?.length; i++) { p.path = []; botInput(s, p); }
  const [x, y] = p.path.at(-1); return { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
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

  p.path = [];
  const unknown = plan(s, p);
  assert.ok(Math.hypot(unknown.x - spot.x, unknown.y - spot.y) > 500, 'an unseen cell is not a destination');

  p.discovery.items.set(cell.id, { ...cell });
  p.path = [];
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

test('a bot enters a reachable roofed frontier cell rather than giving it up from outside (#354 review)', () => {
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
  const s = { tick: 0, phase: 'live', content: contentById('content-2'), map, players: [p], projectiles: [], effects: [], events: [], hazardX: -80, slots: 3, serial: 0 };
  for (; s.tick < 400 && !memory.seen.has(84); s.tick++) {
    movePlayer(map, p, botInput(s, p));
    if (s.tick % DISCOVERY_INTERVAL === 0) discover(memory, map, p, undefined, true);
  }
  assert.ok(memory.seen.has(84), 'the roofed cell is seen by going in');
  assert.ok(memory.items.has('indoor-cell'), 'and the cell inside is seen');
});
