import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView, joinGame } from '../shared/simulation.ts';
import {
  DISCOVERY_CELL_SIZE,
  DISCOVERY_RADIUS,
  DISCOVERY_INTERVAL,
  discoveryGrid,
  cellIndexAt,
  cellCenter,
  createDiscovery,
  discover,
  discoveryWire,
  foldDiscovery,
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

test('discovered field is present only in player own frame projection', () => {
  const game = createGame(4217);
  const c0 = game.players[0]; // contestant
  const c1 = game.players[1]; // contestant
  const g0 = game.players.find(p => p.role === 'gladiator');

  const frame = snapshot(game);

  // 1. In c0's own view: c0 has discovered; c1 does not; g0 does not
  const viewC0 = playerView(game, frame, c0.id);
  const meInView = viewC0.players.find(p => p.id === c0.id);
  assert.ok(meInView.discovered, 'own player projection must carry discovered');
  assert.ok(Array.isArray(meInView.discovered.all), 'initial wire projection must have all');

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
  const game = createGame(4217);
  const c0 = game.players[0];
  const decoder = createDiscoveryDecoder();

  // Tick 0: initial keyframe
  const frame0 = snapshot(game);
  const view0 = playerView(game, frame0, c0.id);
  const me0 = view0.players.find(p => p.id === c0.id);
  assert.ok(me0.discovered?.all, 'tick 0 must emit keyframe all');
  const initialKnown = decoder.decode(me0.discovered);
  assert.equal(initialKnown.size, me0.discovered.all.length);

  // Advance ticks
  let newSetDiscovered = false;
  for (let i = 0; i < 40; i++) {
    // Force player movement across the arena so new cells enter vision
    c0.x += 25;
    step(game);
    const frame = snapshot(game);
    const view = playerView(game, frame, c0.id);
    const me = view.players.find(p => p.id === c0.id);
    if (me.discovered?.set && me.discovered.set.length > 0) {
      newSetDiscovered = true;
    }
    decoder.decode(me.discovered);
  }

  assert.ok(newSetDiscovered, 'movement must produce incremental set deltas');
  assert.deepEqual(decoder.known, c0.discovery.discovered, 'accumulated decoder known set must match full live discovery');
});

test('reconnecting or resuming player receives full keyframe', () => {
  const game = createGame(4217);
  const c0 = game.players[0];

  // Advance some ticks to accumulate discoveries
  for (let i = 0; i < 15; i++) {
    c0.x += 10;
    step(game);
  }

  // A regular tick frame carries set or bare k, not all
  const frameBefore = snapshot(game);
  const viewBefore = playerView(game, frameBefore, c0.id);
  assert.equal(viewBefore.players.find(p => p.id === c0.id).discovered?.all, undefined);

  // Resume or join the slot
  joinGame(game, c0.id, 'contestant', 'warden', 'Resumed');

  // Next tick must emit a full keyframe
  step(game);
  const frameAfter = snapshot(game);
  const viewAfter = playerView(game, frameAfter, c0.id);
  const meAfter = viewAfter.players.find(p => p.id === c0.id);
  assert.ok(meAfter.discovered?.all, 'resumed player must receive keyframe with all');
  assert.equal(meAfter.discovered.all.length, c0.discovery.discovered.size);
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
