import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPhysics } from '../shared/simulation/physics-runtime.ts';
import { firstContact, solidBlockers, staticShapes } from '../shared/simulation/swept.ts';
import { createPhysicsWorld } from '../shared/physics/world.ts';

function fixture() {
  const map = { width: 300, height: 200,
    obstacles: [{ id: 'fence', kind: 'fence', x: 20, y: 20, w: 10, h: 20 }],
    gates: [{ id: 'door', kind: 'gate', x: 220, y: 80, w: 10, h: 40, open: false }],
    playableArea: { cellSize: 100, rows: [
      { y: 0, runs: [[0, 3]] }, { y: 1, runs: [[0, 1], [2, 3]] },
    ] },
  };
  return { map };
}

const body = (id, kind, shape, x, y, angle = 0, collisionProfile) => ({
  spec: { id, kind, shape, collisionProfile },
  transform: { x, y, angle },
});

test('solid blockers retain static mask and gate policy in query order', () => {
  const game = fixture();
  let shapes = solidBlockers(game);
  assert.deepEqual(shapes[0], { kind: 'rect', x: 20, y: 20, w: 10, h: 20 });
  assert.equal(shapes.at(-1).kind, 'rect', 'closed gate follows the static shapes');
  assert.equal(firstContact({ x: 50, y: 150 }, { x: 250, y: 150 }, shapes, 0) < Infinity, true,
    'the missing playable cell blocks the cast');
  assert.equal(firstContact({ x: 205, y: 90 }, { x: 245, y: 90 }, shapes, 0) < Infinity, true,
    'closed gate blocks the cast');
  game.map.gates[0].open = true;
  shapes = solidBlockers(game);
  assert.equal(firstContact({ x: 205, y: 90 }, { x: 245, y: 90 }, shapes, 0), Infinity,
    'opening the gate immediately removes it');
});

test('current solid prop poses block; actors and sensor loot do not', () => {
  const game = fixture();
  game.map.gates[0].open = true;
  const bodies = [
    body('actor:a', 'actor', { kind: 'circle', radius: 12 }, 50, 60),
    body('loot:a', 'prop', { kind: 'circle', radius: 12 }, 75, 60, 0, 'loot'),
    body('round', 'prop', { kind: 'circle', radius: 8 }, 100, 60),
    body('box', 'prop', { kind: 'box', hx: 20, hy: 5 }, 150, 60, Math.PI / 2),
    body('convex', 'prop', { kind: 'convex', vertices: [
      { x: -12, y: -10 }, { x: 12, y: -10 }, { x: 0, y: 12 },
    ] }, 200, 60, Math.PI / 2),
  ];
  let snapshotOptions;
  attachPhysics(game, { world: { snapshot(options) { snapshotOptions = options; return { bodies }; } } });
  let shapes = solidBlockers(game);
  assert.deepEqual(snapshotOptions, { includeStatic: false });
  assert.deepEqual(shapes.slice(-3).map(shape => shape.kind), ['circle', 'polygon', 'polygon']);
  assert.equal(firstContact({ x: 40, y: 60 }, { x: 85, y: 60 }, shapes, 0), Infinity,
    'neither the actor nor sensor loot blocks');
  assert.equal(firstContact({ x: 85, y: 60 }, { x: 115, y: 60 }, shapes, 0) < Infinity, true,
    'solid circle blocks at its solved pose');
  assert.equal(firstContact({ x: 145, y: 75 }, { x: 155, y: 75 }, shapes, 0) < Infinity, true,
    'rotated box reaches above its short unrotated half extent');
  assert.equal(firstContact({ x: 185, y: 60 }, { x: 215, y: 60 }, shapes, 0) < Infinity, true,
    'rotated convex prop blocks');
  bodies[2].transform.x = 120;
  shapes = solidBlockers(game);
  assert.equal(firstContact({ x: 85, y: 60 }, { x: 105, y: 60 }, shapes, 0), Infinity,
    'the next query sees the new prop pose');
});

test('queries preserve cached statics and real world snapshots isolate zero-angle convex vertices', async () => {
  const game = fixture();
  const vertices = [{ x: -4, y: -4 }, { x: 4, y: -4 }, { x: 0, y: 4 }];
  const world = await createPhysicsWorld();
  try {
    world.queueAddBody({ id: 'triangle', kind: 'prop', shape: { kind: 'convex', vertices }, x: 170, y: 50 });
    world.commitMutations();
    attachPhysics(game, { world });
    const cached = staticShapes(game.map, false);
    const original = structuredClone(cached);
    const before = solidBlockers(game);
    assert.strictEqual(before[0], cached[0], 'static descriptors remain borrowed from the cache');
    firstContact({ x: 10, y: 30 }, { x: 50, y: 30 }, before, 0);
    assert.deepEqual(staticShapes(game.map, false), original);
    // A body's spec is frozen and shared, so a query result cannot edit the world through it (#655).
    assert.throws(() => { before.at(-1).points[0].x = -999; }, TypeError);
    assert.notEqual(solidBlockers(game).at(-1).points[0].x, -999);
    assert.deepEqual(world.snapshot().bodies[0].spec.shape.vertices[0], { x: -4, y: -4 });
    assert.deepEqual(vertices[0], { x: -4, y: -4 });
  } finally { world.dispose(); }
});
