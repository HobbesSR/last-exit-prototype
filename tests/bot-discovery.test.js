import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView } from '../shared/simulation.ts';
import { botInput } from '../shared/simulation/bots.ts';
import { canOccupy, TILE } from '../shared/movement.ts';
import { createDiscovery, discover } from '../shared/discovery.ts';
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

test('item memory stays out of snapshots and every projection', () => {
  const { s, p } = lone();
  p.discovery.items.set('remembered-cell', { id: 'remembered-cell', kind: 'cell', x: p.x + 5000, y: p.y });
  const frame = snapshot(s);
  assert.equal(JSON.stringify(frame).includes('remembered-cell'), false);
  for (const viewer of s.players) assert.equal(JSON.stringify(playerView(s, frame, viewer.id)).includes('remembered-cell'), false, viewer.id);
});
