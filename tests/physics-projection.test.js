import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsGame, disposePhysics, snapshot, playerView, PHYSICS_VERSION } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { POTENTIAL } from '../shared/simulation/visibility.ts';
import { minimumReaderForMatch, minimumReaderForMap, SCHEMA } from '../shared/recording.ts';
import { createPhysicsMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { capturePhysicsPresentation } from '../shared/simulation/physics-presentation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';

const content = () => ({ ...structuredClone(contentById('content-1')), roster: { contestants: ['A'], gladiators: [] } });
const arena = () => ({ width: 600, height: 400, playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 100, y: 200 }], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const body = (id, x, y, shape = { kind: 'circle', radius: 5 }, extra = {}) => ({ id, kind: 'prop', shape, x, y, angle: 0.4, vx: 2, vy: -3, omega: 0.2, sleeping: false, generation: 4, ...extra });

test('a moving loot body changes recorded and projected item layers without mutating gameplay during capture', async () => {
  const game = await createPhysicsGame(1, arena(), content());
  try {
    game.map.items.push({ id: 'loot', kind: 'cell', charge: 100, x: 300, y: 200 });
    const world = physicsRuntime(game).world;
    world.queueAddBody({ id: 'item:loot', kind: 'prop', shape: { kind: 'circle', radius: 5 }, x: 300, y: 200 });
    world.commitMutations();
    const encoder = createLayerEncoder(), initial = encoder.encode(playerView(game, snapshot(game), game.players[0].id));
    world.setTransform('item:loot', { x: 350, y: 220, angle: 1 });
    const captured = snapshot(game), projected = playerView(game, captured, game.players[0].id);
    assert.deepEqual([captured.items[0].x, captured.items[0].y], [350, 220]);
    assert.deepEqual([projected.items[0].x, projected.items[0].y], [350, 220]);
    assert.equal(game.map.items[0].x, 300, 'snapshot is read-only');
    const moved = encoder.encode(projected);
    assert.equal(moved.items.k, initial.items.k);
    assert.equal(moved.items.changes.set[0].x, 350, 'actual body movement invalidates the item layer');
  } finally { disposePhysics(game); }
});

test('real physics snapshot is detached and its public body is a closed display value', async () => {
  const game = await createPhysicsGame(1, arena(), content());
  try {
    const frame = snapshot(game), own = frame.players[0], view = playerView(game, frame, own.id);
    assert.equal(frame.version, PHYSICS_VERSION);
    assert.ok(frame.physics?.settings && frame.physics.world);
    assert.equal(frame.physics.world.bodies.some(b => b.spec.kind === 'static'), false);
    assert.equal(frame.bodies.some(b => b.kind === 'static'), false);
    assert.equal(frame.bodies.length, 1);
    assert.equal(frame.bodies[0].actorId, own.id);
    assert.equal(frame.bodies[0].generation, frame.physics.world.bodies[0].generation);
    assert.equal(view.physics, undefined);
    assert.equal(view.physicsProfile, frame.physicsProfile);
    assert.deepEqual(view.bodies, frame.bodies);
    assert.deepEqual(view.tethers, []);
    frame.bodies[0].vx = 999;
    assert.notEqual(snapshot(game).bodies[0].vx, 999);
    const privateState = structuredClone(frame.physics), spec = privateState.world.bodies[0];
    privateState.world.bodies.push({ ...spec, spec: { ...spec.spec, id: 'actor:missing' } },
      { ...spec, spec: { ...spec.spec, id: 'item:missing', kind: 'prop' } });
    assert.deepEqual(capturePhysicsPresentation(privateState, frame).bodies.map(b => b.id), [frame.bodies[0].id],
      'stale actor/item bodies cannot become unassociated public props');
  } finally { disposePhysics(game); }
});

test('projection gates actors, prop bounds, item associations and both tether endpoints from the stored frame', async () => {
  const game = await createPhysicsGame(1, arena(), content());
  try {
    const frame = snapshot(game), own = frame.players[0];
    own.x = 100; own.y = 200;
    const near = { ...own, id: 'near', x: 110, y: 200, status: 'active' };
    const far = { ...own, id: 'far', x: POTENTIAL + 500, y: 200, status: 'active' };
    frame.players.push(near, far);
    frame.items.push({ id: 'loot', x: 120, y: 200 }, { id: 'hidden-loot', x: POTENTIAL + 500, y: 200 });
    const ownBody = { ...frame.bodies[0], x: 100, y: 200, vx: 7, generation: 8, secret: 'own-secret', shape: { ...frame.bodies[0].shape, backend: 'shape-secret' } };
    const nearBody = body('actor:near', 110, 200, undefined, { kind: 'actor', actorId: 'near', pendingForce: 'private' });
    const farBody = body('actor:far', far.x, far.y, undefined, { kind: 'actor', actorId: 'far' });
    const edge = body('edge', POTENTIAL + 103, 200, { kind: 'circle', radius: 110 });
    const hidden = body('hidden', POTENTIAL + 130, 200, { kind: 'box', hx: 2, hy: 3 });
    const loot = body('item:loot', 120, 200, undefined, { itemId: 'loot' });
    const hiddenLoot = body('item:hidden-loot', 120, 200, undefined, { itemId: 'hidden-loot' });
    const orphan = body('item:orphan', 120, 200, undefined, { itemId: 'orphan' });
    frame.bodies = [ownBody, nearBody, farBody, edge, hidden, loot, hiddenLoot, orphan];
    frame.tethers = [{ id: 'shown', a: ownBody.id, b: nearBody.id, anchor: 'private' }, { id: 'hidden', a: ownBody.id, b: farBody.id }, { id: 'orphan', a: ownBody.id, b: orphan.id }];
    frame.physics.settings.secret = 'settings-secret';
    frame.physics.world.pending.forces.push({ id: 'actor:far', value: { x: 123, y: 0 } });
    const view = playerView(game, frame, own.id);
    assert.deepEqual(view.bodies.map(b => b.id), [ownBody.id, nearBody.id, edge.id, loot.id]);
    assert.deepEqual(view.tethers, [{ id: 'shown', a: ownBody.id, b: nearBody.id }]);
    assert.equal(view.bodies[0].vx, 7);
    assert.equal(view.bodies[0].generation, 8);
    assert.equal(view.physics, undefined);
    const wire = JSON.stringify(view);
    for (const secret of ['own-secret', 'shape-secret', 'private', 'settings-secret', 'actor:far', 'item:hidden-loot', 'item:orphan']) assert.equal(wire.includes(secret), false, secret);

    // Delayed projection reads the captured frame, never the live positions after it was captured.
    game.players[0].x = far.x; game.players[0].y = far.y;
    const delayed = playerView(game, frame, own.id);
    assert.deepEqual(delayed.bodies.map(b => b.id), view.bodies.map(b => b.id));
  } finally { disposePhysics(game); }
});

test('physics recording floor is explicit and stamped by the room writer', async () => {
  assert.equal(SCHEMA, 10);
  for (const version of ['last-exit-0.8-physics-1', 'last-exit-0.8-physics-2']) assert.equal(minimumReaderForMatch(arena(), version), 10);
  assert.equal(minimumReaderForMatch({ obstacles: [] }, 'last-exit-0.8'), minimumReaderForMap({ obstacles: [] }));
  let header;
  const service = createRoomService({ content, matchFactory: createPhysicsMatch,
    replays: { start(h) { header = h; return { append() { return true; }, finish() { return {}; } }; } } });
  const room = service.makeRoom(1, false, undefined, arena());
  try {
    await room.ready;
    const peer = service.connect({ deliver() { return true; }, close() {} });
    service.receive(peer, { type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant', name: 'Test' });
    service.receive(peer, { type: 'start' });
    assert.equal(header.schema, 10);
    assert.equal(header.minSchema, 10);
  } finally { await service.close(); }
});
