import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView, joinGame } from '../shared/simulation.ts';
import { createMatch } from '../server/match.js';
import { broadcast } from '../server/room-views.js';
import {
  DISCOVERY_CELL_SIZE,
  DISCOVERY_RADIUS,
  DISCOVERY_INTERVAL,
  BEACON_RADIUS,
  discoveryGrid,
  cellIndexAt,
  cellCenter,
  createDiscovery,
  discover,
  foldDiscovery,
  createDiscoveryEncoder,
  createDiscoveryDecoder,
  isDiscovered,
  isFeatureDiscovered,
} from '../shared/discovery.ts';

test('discovery grid dimensions and cell coordinates match map scale', () => {
  const map = { width: 1920, height: 960 };
  const grid = discoveryGrid(map);
  assert.equal(grid.cols, 10);
  assert.equal(grid.rows, 5);
  assert.equal(grid.size, DISCOVERY_CELL_SIZE);

  const idx = cellIndexAt(map, 0, 0);
  assert.equal(idx, 0);
  const center0 = cellCenter(map, 0);
  assert.deepEqual(center0, { x: 96, y: 96 });

  const idxNext = cellIndexAt(map, 200, 0);
  assert.equal(idxNext, 1);
  const centerNext = cellCenter(map, 1);
  assert.deepEqual(centerNext, { x: 288, y: 96 });

  // Out of bounds coordinates clamp to -1
  assert.equal(cellIndexAt(map, -10, 50), -1);
  assert.equal(cellIndexAt(map, 50, -10), -1);
  assert.equal(cellIndexAt(map, map.width + 10, 50), -1);
  assert.equal(cellIndexAt(map, 50, map.height + 10), -1);

  const memory = createDiscovery();
  assert.equal(isDiscovered(memory, map, -10, 50), false);
  assert.equal(isDiscovered(memory, map, map.width + 10, 50), false);
});

test('a contestant discovers cells it can see and not cells behind a wall', () => {
  const memory = createDiscovery();
  // Map 1920x960: cols = 10, rows = 5
  // Origin at cell (1, 1): center = (288, 288)
  const eye = { x: 288, y: 288 };
  // Wall between column 2 and column 3, blocking sight to the east
  const wall = { id: 'wall', x: 384, y: 192, w: 20, h: 200 };
  const playableArea = { cellSize: 192, rows: Array.from({ length: 5 }, (_, y) => ({ y, runs: [[0, 10]] })) };
  const map = {
    width: 1920,
    height: 960,
    playableArea,
    obstacles: [wall],
    gates: [],
    buildings: [],
  };

  const newlyDiscovered = discover(memory, map, eye);
  assert.ok(newlyDiscovered.length > 0, 'some cells should be discovered');

  // Eye's own cell: col 1, row 1 -> index 1 * 10 + 1 = 11
  const eyeCell = cellIndexAt(map, eye.x, eye.y);
  assert.ok(memory.discovered.has(eyeCell), 'own cell must be discovered');
  assert.ok(isDiscovered(memory, map, eye.x, eye.y));

  // Cell directly to the west (col 0, row 1 -> index 10) is clear of walls
  const westCell = cellIndexAt(map, 96, 288);
  assert.ok(memory.discovered.has(westCell), 'unobstructed cell to the west must be discovered');

  // Cell to the east behind the wall (col 3, row 1 -> index 13, center 672, 288)
  const eastCell = cellIndexAt(map, 672, 288);
  assert.equal(memory.discovered.has(eastCell), false, 'cell behind wall must not be discovered');
  assert.equal(isDiscovered(memory, map, 672, 288), false);
});

test('cells under a roof are concealed from a viewer outside', () => {
  const memory = createDiscovery();
  const eye = { x: 200, y: 200 };
  // Building located at (384, 192) covering cell (2, 1) [384..576, 192..384]
  const building = { id: 'b1', nodeId: 'node-1', x: 384, y: 192, w: 192, h: 192 };
  const playableArea = { cellSize: 192, rows: Array.from({ length: 5 }, (_, y) => ({ y, runs: [[0, 10]] })) };
  const map = {
    width: 1920,
    height: 960,
    playableArea,
    obstacles: [],
    gates: [],
    buildings: [building],
  };

  discover(memory, map, eye);

  // Cell inside the building: col 2, row 1 -> center (480, 288)
  const roofCell = cellIndexAt(map, 480, 288);
  assert.equal(memory.discovered.has(roofCell), false, 'cell under roof must not be discovered from outside');
  // Cell outside the building near eye (288, 288) is discovered
  const outsideCell = cellIndexAt(map, 200, 200);
  assert.ok(memory.discovered.has(outsideCell), 'cell outside building must be discovered');
});

test('cells beyond DISCOVERY_RADIUS are not discovered', () => {
  const memory = createDiscovery();
  const eye = { x: 100, y: 100 };
  const map = {
    width: 4000,
    height: 4000,
    obstacles: [],
    gates: [],
    buildings: [],
  };

  discover(memory, map, eye);

  // Point far away (e.g. 2000, 2000) > DISCOVERY_RADIUS (1200)
  assert.equal(isDiscovered(memory, map, 2000, 2000), false);
});

test('gladiators have no discovery memory', () => {
  const game = createGame(4217);
  const gladiator = game.players.find(p => p.role === 'gladiator');
  assert.ok(gladiator, 'gladiator exists');
  assert.equal(gladiator.discovery, undefined, 'gladiator must not have discovery memory');
  assert.equal(gladiator.discovered, undefined, 'gladiator must not have discovered wire field');

  // Fold over frames for a gladiator returns empty memory
  const frame = snapshot(game);
  const folded = foldDiscovery(game.map, [frame], gladiator.id);
  assert.equal(folded.discovered.size, 0, 'gladiator fold must have 0 discovered cells');
});

test('discovery is stable under a pure fold over recorded frames', () => {
  const game = createGame(4217);
  const contestant = game.players.find(p => p.role === 'contestant');
  assert.ok(contestant && contestant.discovery);

  const frames = [];
  frames.push({ tick: game.tick, gates: game.map.gates, players: snapshot(game).players });

  // Advance simulation for 30 ticks to trigger multiple discovery cycles
  for (let i = 0; i < 30; i++) {
    step(game);
    frames.push({ tick: game.tick, gates: game.map.gates, players: snapshot(game).players });
  }

  const liveDiscovered = new Set(contestant.discovery.discovered);
  assert.ok(liveDiscovered.size > 0, 'live contestant must have discovered cells');

  const folded = foldDiscovery(game.map, frames, contestant.id);
  assert.deepEqual(folded.discovered, liveDiscovered, 'folded discovery must exactly match live discovery');
});

test('discovered field is present only in player own frame projection as plain array', () => {
  const game = createGame(4217);
  const c0 = game.players[0]; // contestant
  const c1 = game.players[1]; // contestant
  const g0 = game.players.find(p => p.role === 'gladiator');

  const frame = snapshot(game);

  // 1. In c0's own view: c0 has discovered; c1 does not; g0 does not
  const viewC0 = playerView(game, frame, c0.id);
  const meInView = viewC0.players.find(p => p.id === c0.id);
  assert.ok(meInView.discovered, 'own player projection must carry discovered');
  assert.ok(Array.isArray(meInView.discovered), 'own player projection carries plain array of cell indices');
  assert.ok(meInView.discovered.length > 0);

  const otherContestant = viewC0.players.find(p => p.id === c1.id);
  if (otherContestant) {
    assert.equal(otherContestant.discovered, undefined, 'other contestant must not carry discovered');
  }

  const gladiatorInView = viewC0.players.find(p => p.id === g0.id);
  if (gladiatorInView) {
    assert.equal(gladiatorInView.discovered, undefined, 'gladiator in view must not carry discovered');
  }

  // 2. In spectator view: no player carries discovered
  const viewSpectator = playerView(game, frame, 'spectator');
  for (const p of viewSpectator.players) {
    assert.equal(p.discovered, undefined, 'spectator view must never carry discovered');
  }

  // 3. In gladiator own view: gladiator has no discovered
  const viewG0 = playerView(game, frame, g0.id);
  const gMe = viewG0.players.find(p => p.id === g0.id);
  assert.equal(gMe.discovered, undefined, 'gladiator own projection must not carry discovered');
});

test('keyframe-then-changes deltas add up to the keyframe', () => {
  const encoder = createDiscoveryEncoder();
  const decoder = createDiscoveryDecoder();

  // Baseline keyframe
  const initial = [1, 2, 3];
  const encoded0 = encoder.encode(initial);
  assert.ok(encoded0.k > 0);
  const initialWire = encoded0.all();
  assert.deepEqual(initialWire.all, [1, 2, 3]);
  decoder.decode(initialWire);
  assert.deepEqual(decoder.known, new Set([1, 2, 3]));

  // Incremental additions
  const step1 = [1, 2, 3, 4, 5];
  const encoded1 = encoder.encode(step1);
  assert.equal(encoded1.k, encoded0.k, 'same keyframe retained when within budget');
  assert.deepEqual(encoded1.changes.set, [4, 5]);
  decoder.decode(encoded1.changes);
  assert.deepEqual(decoder.known, new Set([1, 2, 3, 4, 5]));

  // Exceeding rekey floor triggers new keyframe
  const many = Array.from({ length: 30 }, (_, i) => i + 1);
  const encodedMany = encoder.encode(many);
  assert.ok(encodedMany.k > encoded0.k, 'new process-unique keyframe cut when changes exceed budget');
  const manyWire = encodedMany.all();
  assert.deepEqual(manyWire.all, many);
  decoder.decode(manyWire);
  assert.deepEqual(decoder.known, new Set(many));

  // Dropping/forgetting cells triggers re-key
  const dropped = [1, 2];
  const encodedDrop = encoder.encode(dropped);
  assert.ok(encodedDrop.k > encodedMany.k, 'dropping cells triggers new keyframe');
  assert.deepEqual(encodedDrop.all().all, [1, 2]);

  // Plain array replaces known set in decoder
  const plain = [100, 101];
  decoder.decode(plain);
  assert.deepEqual(decoder.known, new Set([100, 101]));
});

test('room broadcast: dropped frames and catch-up batches preserve client discovery', () => {
  const match = createMatch(4217);
  const c0 = match.diagnosticState.players[0];

  const delivered = [];
  let shouldDrop = false;
  const session = {
    playerId: c0.id,
    deliver(payload, droppable) {
      if (shouldDrop && droppable) {
        shouldDrop = false;
        return false; // simulate websocket backpressure drop
      }
      delivered.push(JSON.parse(payload));
      return true;
    }
  };

  const room = {
    id: 'test-room',
    match,
    clients: new Set([session]),
    history: [],
  };

  const decoder = createDiscoveryDecoder();

  // 1. Initial broadcast: simulate dropped initial keyframe under backpressure
  shouldDrop = true;
  broadcast(room, match.snapshot());
  assert.equal(delivered.length, 0, 'initial frame was dropped, nothing delivered');

  // Next frame: session that missed the initial keyframe must be sent all
  broadcast(room, match.snapshot());
  assert.equal(delivered.length, 1, 'subsequent frame delivered');
  const firstFrame = delivered[0].state;
  const me0 = firstFrame.players.find(p => p.id === c0.id);
  assert.ok(me0.discovered?.all, 'session that missed keyframe must be sent all');
  decoder.decode(me0.discovered);
  assert.deepEqual(decoder.known, c0.discovery.discovered);

  // 2. Advance ticks and simulate a dropped intermediate delta frame
  for (let i = 0; i < 5; i++) {
    c0.x += 25;
    match.advance();
  }
  shouldDrop = true;
  broadcast(room, match.snapshot());
  assert.equal(delivered.length, 1, 'intermediate frame was dropped, delivered count unchanged');

  // Advance more ticks and broadcast
  for (let i = 0; i < 5; i++) {
    c0.x += 25;
    match.advance();
  }
  broadcast(room, match.snapshot());
  assert.equal(delivered.length, 2, 'subsequent frame delivered');
  const catchupFrame = delivered[1].state;
  const meCatchup = catchupFrame.players.find(p => p.id === c0.id);
  // Changes are measured cumulatively against keyframe baseline, so no cells are lost
  decoder.decode(meCatchup.discovered);
  assert.deepEqual(decoder.known, c0.discovery.discovered, 'client decoder recovers all cells despite dropped delta frame');

  // 3. Catch-up batch: simulate room-service advance() stepping multiple ticks before broadcasting
  for (let i = 0; i < 5; i++) {
    c0.x += 25;
    match.advance();
  }
  broadcast(room, match.snapshot());
  assert.equal(delivered.length, 3);
  const batchFrame = delivered[2].state;
  const meBatch = batchFrame.players.find(p => p.id === c0.id);
  decoder.decode(meBatch.discovered);
  assert.deepEqual(decoder.known, c0.discovery.discovered, 'client decoder matches after catch-up batch');
});

test('feature discovery query identifies discovered chargers and stations', () => {
  const game = createGame(4217);
  const c0 = game.players[0];
  const memory = c0.discovery;

  // Spawns near c0 must be discovered
  const nearbySpawn = game.map.spawns[0];
  assert.ok(isFeatureDiscovered(memory, game.map, nearbySpawn));

  // Exit site at the far end of the map must not be discovered at start
  const exit = game.map.exit;
  assert.equal(isFeatureDiscovered(memory, game.map, exit), false);
});

test('a landmark is discovered from its beacon radius, through walls, and the fold agrees', () => {
  // A wall across the map east of the eye, so sight alone discovers nothing beyond it.
  const map = {
    width: 6000, height: 960, obstacles: [{ id: 'wall', x: 400, y: 0, w: 20, h: 960 }], gates: [], buildings: [],
    chargers: [{ id: 'near', x: 400 + BEACON_RADIUS - 1000, y: 480 }, { id: 'far', x: 200 + BEACON_RADIUS + 400, y: 480 }],
    stations: [], exit: { x: 5900, y: 480 },
  };
  const eye = { x: 200, y: 480 }, memory = createDiscovery();
  discover(memory, map, eye);
  const [near, far] = map.chargers;
  assert.ok(isFeatureDiscovered(memory, map, near), 'a charger inside the beacon radius, behind a wall');
  assert.equal(isDiscovered(memory, map, near.x - DISCOVERY_CELL_SIZE, near.y), false, 'only its own cell, not the way to it');
  assert.equal(isFeatureDiscovered(memory, map, far), false, 'a charger beyond the beacon radius');
  assert.equal(isFeatureDiscovered(memory, map, map.exit), false, 'the exit beyond it');
  const folded = foldDiscovery(map, [{ tick: 0, players: [{ id: 'c0', ...eye, role: 'contestant', status: 'active' }] }], 'c0');
  assert.deepEqual([...folded.discovered].sort(), [...memory.discovered].sort());
});
