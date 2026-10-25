import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, setInput, snapshot, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { dynamicNavigationWork, dynamicWaypoint, observedBlockers } from '../shared/simulation/dynamic-navigation.ts';

function fixture({ spawns = [{ x: 150, y: 400 }], gladiator = false, props = [], obstacles = [], items = [], contentId = 'content-physics-8' } = {}) {
  const map = { seed: 448, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items, traps: [], routes: [], nodes: [], streets: [], physicsProps: props,
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById(contentId));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`), gladiators: gladiator ? [{ name: 'G', kit: 'warden' }] : [] };
  content.discovery = false;
  return { map, content };
}
async function game(options) {
  const { map, content } = fixture(options), s = await createPhysicsGame(448, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}
function drive(s, p, target) {
  const at = dynamicWaypoint(s, p, target), dx = at.x - p.x, dy = at.y - p.y;
  const length = Math.max(9, Math.hypot(dx, dy));
  assert.ok(setInput(s, p.id, { seq: s.tick + 1, x: dx / length, y: dy / length }));
  step(s);
  const pose = physicsRuntime(s).world.getTransform(`actor:${p.id}`);
  assert.ok(pose && Math.hypot(pose.x - p.x, pose.y - p.y) < 0.01,
    `actor gameplay and body pose agree: player=(${p.x},${p.y}) body=${JSON.stringify(pose)}`);
  return at;
}

test('physical motor detours around sleeping and moving rotated crates and reaches the goal', async () => {
  for (const moving of [false, true]) {
    const s = await game({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400, angle: Math.PI / 4 }] });
    try {
      const p = s.players[0], world = physicsRuntime(s).world, target = { x: 480, y: 400 };
      if (!moving) {
        for (let i = 0; i < 400 && !world.getTransform('prop:crate').sleeping; i++) step(s);
        assert.equal(world.getTransform('prop:crate').sleeping, true, JSON.stringify(world.getTransform('prop:crate')));
      }
      while (s.tick % 4 !== 0) step(s);
      if (moving) world.queueImpulse('prop:crate', { x: 0, y: 300 });
      const first = dynamicWaypoint(s, p, target);
      assert.notDeepEqual(first, target);
      assert.ok(dynamicNavigationWork(s) > 0 && dynamicNavigationWork(s) <= 192);
      let deviated = false, moved = false;
      for (let i = 0; i < 90; i++) {
        const at = drive(s, p, target);
        if (Math.abs(at.y - 400) > 5 || Math.abs(p.y - 400) > 5) deviated = true;
        if (Math.abs(world.getTransform('prop:crate').y - 400) > 0.01) moved = true;
      }
      assert.ok(deviated, `${moving ? 'moving' : 'sleeping'} crate caused a detour`);
      assert.ok(p.x > 380, `actor progressed around ${moving ? 'moving' : 'sleeping'} crate: ${p.x}`);
      if (moving) assert.ok(moved, `crate moved after impulse: tick=${s.tick} phase=${s.phase} pose=${JSON.stringify(world.getTransform('prop:crate'))}`);
    } finally { disposePhysics(s); }
  }
});

test('mixed actor radii cause a detour while loot sensors leave the straight waypoint intact', async () => {
  const s = await game({ gladiator: true, items: [{ id: 'sensor', kind: 'cell', charge: 10, x: 220, y: 400 }] });
  try {
    const p = s.players.find(p => p.role === 'contestant'), g = s.players.find(p => p.role === 'gladiator');
    const goal = { x: 480, y: 400 };
    assert.equal(observedBlockers(s, p).length, 1, 'only the larger gladiator footprint blocks');
    let deviated = false;
    for (let i = 0; i < 80; i++) {
      const at = drive(s, p, goal);
      if (Math.abs(at.y - 400) > 5) deviated = true;
    }
    assert.ok(deviated);
    assert.ok(p.x > g.x + 30, `contestant passed the larger blocker: ${p.x}`);
  } finally { disposePhysics(s); }
  const lootOnly = await game({ items: [{ id: 'sensor', kind: 'cell', charge: 10, x: 220, y: 400 }] });
  try { assert.deepEqual(dynamicWaypoint(lootOnly, lootOnly.players[0], { x: 480, y: 400 }), { x: 480, y: 400 }); }
  finally { disposePhysics(lootOnly); }
});

test('collectBotIntent drives an actual contestant around a crate toward a cell', async () => {
  const s = await game({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400, angle: Math.PI / 6 }],
    items: [{ id: 'goal-cell', kind: 'cell', charge: 0, x: 500, y: 400 }] });
  try {
    const p = s.players[0];
    p.bot = true;
    let deviated = false;
    for (let i = 0; i < 100; i++) {
      step(s);
      if (Math.abs(p.y - 400) > 5) deviated = true;
    }
    assert.ok(deviated, 'bot chose an actual lateral motor path');
    assert.ok(p.x > 390, `bot advanced toward the cell: ${p.x}`);
  } finally { disposePhysics(s); }
});

test('narrow corridor queues behind an actor without tunneling, then resumes when clear', async () => {
  const obstacles = [{ id: 'top', x: 100, y: 100, w: 500, h: 280 },
    { id: 'bottom', x: 100, y: 420, w: 500, h: 280 }];
  const s = await game({ spawns: [{ x: 200, y: 400 }, { x: 300, y: 400 }], obstacles });
  try {
    const [p, blocker] = s.players, goal = { x: 500, y: 400 };
    for (let i = 0; i < 20; i++) drive(s, p, goal);
    assert.ok(p.x < blocker.x - 20, `actor waited outside blocker: ${p.x}`);
    assert.ok(blocker.x - p.x < 30, `actor reached the queue instead of stopping at observation range: gap=${blocker.x - p.x}`);
    assert.ok(p.y > 390 && p.y < 410, `actor stayed inside corridor: ${p.y}`);
    assert.ok(teleport(s, blocker.id, 650, 500));
    for (let i = 0; i < 50; i++) drive(s, p, goal);
    assert.ok(p.x > 390, `actor resumed after corridor cleared: ${p.x}`);
  } finally { disposePhysics(s); }
});

test('hidden actors and wall-concealed props do not alter local waypoints; old content stays unchanged', async () => {
  const cloaked = await game({ spawns: [{ x: 150, y: 400 }, { x: 300, y: 400 }] });
  try {
    const [p, other] = cloaked.players, goal = { x: 480, y: 400 };
    other.cloak = true;
    assert.equal(observedBlockers(cloaked, p).length, 0);
    const before = dynamicWaypoint(cloaked, p, goal);
    other.x = 350;
    assert.equal(observedBlockers(cloaked, p).length, 0);
    assert.deepEqual(dynamicWaypoint(cloaked, p, goal), before);
  } finally { disposePhysics(cloaked); }
  const wall = await game({ props: [{ id: 'hidden', profile: 'crate', x: 300, y: 400 }],
    obstacles: [{ id: 'wall', x: 230, y: 300, w: 4, h: 200 }] });
  try {
    const p = wall.players[0], goal = { x: 480, y: 400 }, world = physicsRuntime(wall).world;
    assert.equal(observedBlockers(wall, p).length, 0);
    const before = dynamicWaypoint(wall, p, goal);
    world.setTransform('prop:hidden', { x: 350, y: 430, angle: Math.PI / 3 });
    assert.equal(observedBlockers(wall, p).length, 0);
    assert.deepEqual(dynamicWaypoint(wall, p, goal), before);
  } finally { disposePhysics(wall); }
  const old = await game({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400 }], contentId: 'content-physics-5' });
  try { assert.deepEqual(dynamicWaypoint(old, old.players[0], { x: 480, y: 400 }), { x: 480, y: 400 }); }
  finally { disposePhysics(old); }
});

test('teleport discards a stale detour and follows the new destination', async () => {
  const s = await game({ props: [{ id: 'crate', profile: 'crate', x: 300, y: 400 }] });
  try {
    const p = s.players[0];
    const detour = dynamicWaypoint(s, p, { x: 480, y: 400 });
    assert.notDeepEqual(detour, { x: 480, y: 400 });
    assert.ok(teleport(s, p.id, 500, 500));
    const newGoal = { x: 650, y: 500 };
    assert.deepEqual(dynamicWaypoint(s, p, newGoal), newGoal);
  } finally { disposePhysics(s); }
});

test('P8 selects the physics coordinator without adding snapshot fields', async () => {
  const p8 = await game(), p6 = await game({ contentId: 'content-physics-6' });
  try {
    assert.equal(p8.version, 'last-exit-0.8-physics-8');
    drive(p8, p8.players[0], { x: 300, y: 400 });
    const current = snapshot(p8), previous = snapshot(p6);
    assert.equal(current.version, 'last-exit-0.8-physics-8');
    assert.deepEqual(Object.keys(current).sort(), Object.keys(previous).sort());
    assert.deepEqual(Object.keys(current.physics).sort(), Object.keys(previous.physics).sort());
  } finally { disposePhysics(p8); disposePhysics(p6); }
});
