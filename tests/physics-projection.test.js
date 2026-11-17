import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, step, snapshot, playerView, PHYSICS_VERSION } from '../shared/simulation.ts';
import { hookSkill } from '../shared/simulation/hook.ts';
import { contentById } from '../shared/simulation/content.ts';
import { POTENTIAL } from '../shared/simulation/visibility.ts';
import { minimumReaderForMatch, MIN_SCHEMA, SCHEMA } from '../shared/recording.ts';
import { createMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { capturePhysicsPresentation } from '../shared/simulation/physics-presentation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { createLayerEncoder } from '../shared/frame-layers.ts';
import { openArea } from './helpers/arena.js';
import { identifyItems } from './helpers/item-identity.js';

const content = () => ({ ...structuredClone(contentById('content-7')), roster: { contestants: ['A'], gladiators: [] } });
const arena = () => ({ width: 600, height: 400, playableArea: openArea(600, 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 100, y: 200 }], stations: [], chargers: [], sensors: [], items: [], traps: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const body = (id, x, y, shape = { kind: 'circle', radius: 5 }, extra = {}) => ({ id, owner: { kind: 'prop', propId: id }, kind: 'prop', shape, x, y, angle: 0.4, vx: 2, vy: -3, omega: 0.2, sleeping: false, generation: 4, ...extra });

test('a moving loot body changes recorded and projected item layers without mutating gameplay during capture', async () => {
  const game = await createGame(1, arena(), content());
  try {
    game.map.items.push({ id: 'loot', kind: 'cell', charge: 100, x: 300, y: 200 });
    identifyItems(game);
    const world = physicsRuntime(game).world;
    world.queueAddBody({ id: 'item:loot', kind: 'prop', shape: { kind: 'circle', radius: 5 }, x: 300, y: 200 });
    world.commitMutations();
    const encoder = createLayerEncoder(), initial = encoder.encode(playerView(game, snapshot(game), game.players[0].id));
    world.setTransform('item:loot', { x: 350, y: 220, angle: 1 });
    const captured = snapshot(game), projected = playerView(game, captured, game.players[0].id);
    assert.equal('x' in captured.items[0], false);
    assert.deepEqual([captured.bodies.find(b => b.owner.kind === 'item').x, captured.bodies.find(b => b.owner.kind === 'item').y], [350, 220]);
    assert.equal('x' in projected.items[0], false);
    assert.equal(game.map.items[0].x, 300, 'snapshot is read-only');
    const moved = encoder.encode(projected);
    assert.equal(moved.items.k, initial.items.k);
    assert.equal(moved.items.changes.set, undefined, 'physical movement changes only the body layer');
    assert.equal(moved.bodies.changes.set.find(b => b.owner.kind === 'item').x, 350);
  } finally { disposePhysics(game); }
});

test('real physics snapshot is detached and its public body is a closed display value', async () => {
  const game = await createGame(1, arena(), content());
  try {
    const frame = snapshot(game), own = frame.players[0], view = playerView(game, frame, own.id);
    assert.equal(frame.version, PHYSICS_VERSION);
    assert.ok(frame.physics?.world);
    assert.equal('settings' in frame.physics, false);
    assert.equal('profile' in frame.physics, false);
    assert.equal('pending' in frame.physics.world, false);
    assert.equal(frame.physics.world.bodies.some(b => b.spec.kind === 'static'), false);
    assert.equal(frame.bodies.some(b => b.kind === 'static'), false);
    assert.equal(frame.bodies.length, 1);
    assert.deepEqual(frame.bodies[0].owner, { kind: 'actor', playerIdx: own.playerIdx });
    assert.equal(frame.bodies[0].generation, frame.physics.world.bodies[0].generation);
    assert.equal(view.physics, undefined);
    assert.equal(view.physicsProfile, frame.physicsProfile);
    assert.deepEqual(view.bodies, frame.bodies);
    assert.deepEqual(view.tethers, []);
    frame.bodies[0].vx = 999;
    assert.notEqual(snapshot(game).bodies[0].vx, 999);
    const world = physicsRuntime(game).world, spec = frame.physics.world.bodies[0].spec;
    world.queueAddBody({ ...spec, id: 'actor:missing' });
    world.queueAddBody({ ...spec, id: 'item:missing', kind: 'prop' });
    world.commitMutations();
    assert.deepEqual(capturePhysicsPresentation(game).bodies.map(b => b.id), [frame.bodies[0].id],
      'stale actor/item bodies cannot become unassociated public props');
  } finally { disposePhysics(game); }
});

test('projection gates actors, prop bounds, item associations and both tether endpoints from the stored frame', async () => {
  const game = await createGame(1, arena(), content());
  try {
    const frame = snapshot(game), own = frame.players[0];
    own.x = 100; own.y = 200;
    const near = { ...own, id: 'near', playerIdx: 1, x: 110, y: 200, status: 'active' };
    const far = { ...own, id: 'far', playerIdx: 2, x: POTENTIAL + 500, y: 200, status: 'active' };
    frame.players.push(near, far);
    // A frame's ground list is shared and frozen (22.1 "Frames"), so the scenario gets its own.
    frame.items = [...frame.items, { id: 'loot', x: 120, y: 200 }, { id: 'hidden-loot', x: POTENTIAL + 500, y: 200 }];
    const ownBody = { ...frame.bodies[0], x: 100, y: 200, vx: 7, generation: 8, secret: 'own-secret', shape: { ...frame.bodies[0].shape, backend: 'shape-secret' } };
    const nearBody = body('actor:near', 110, 200, undefined, { kind: 'actor', owner: { kind: 'actor', playerIdx: 1 }, pendingForce: 'private' });
    const farBody = body('actor:far', far.x, far.y, undefined, { kind: 'actor', owner: { kind: 'actor', playerIdx: 2 } });
    const edge = body('edge', POTENTIAL + 103, 200, { kind: 'circle', radius: 110 });
    const hidden = body('hidden', POTENTIAL + 130, 200, { kind: 'box', hx: 2, hy: 3 });
    const loot = body('item:loot', 120, 200, undefined, { owner: { kind: 'item', itemId: 'loot' } });
    const hiddenLoot = body('item:hidden-loot', POTENTIAL + 500, 200, undefined, { owner: { kind: 'item', itemId: 'hidden-loot' } });
    const orphan = body('item:orphan', 120, 200, undefined, { owner: { kind: 'item', itemId: 'orphan' } });
    frame.physics = { ...frame.physics, secret: 'settings-secret' };
    frame.bodies = [ownBody, nearBody, farBody, edge, hidden, loot, hiddenLoot, orphan];
    frame.tethers = [{ id: 'shown', a: ownBody.id, b: nearBody.id, anchor: 'private' }, { id: 'hidden', a: ownBody.id, b: farBody.id }, { id: 'orphan', a: ownBody.id, b: orphan.id }];
    const view = playerView(game, frame, own.id);
    assert.deepEqual(view.bodies.map(b => b.id), [ownBody.id, nearBody.id, edge.id, loot.id]);
    assert.deepEqual(view.tethers, [{ id: 'shown', a: ownBody.id, b: nearBody.id }]);
    assert.equal(view.bodies[0].vx, 7);
    assert.equal(view.bodies[0].generation, 8);
    const seenOpponent = view.bodies.find(b => b.id === nearBody.id);
    for (const key of ['vx', 'vy', 'omega', 'sleeping']) {
      assert.equal(Object.hasOwn(seenOpponent, key), false, `observed actor omits ${key}`);
      assert.equal(playerView(game, frame, near.id).bodies.find(b => b.id === nearBody.id)[key], nearBody[key], `own body retains ${key}`);
      assert.equal(playerView(game, frame, null).bodies.find(b => b.id === nearBody.id)[key], nearBody[key], `directed body retains ${key}`);
      assert.equal(frame.bodies.find(b => b.id === nearBody.id)[key], nearBody[key], `recorded body retains ${key}`);
    }
    assert.equal(view.physics, undefined);
    const wire = JSON.stringify(view);
    for (const secret of ['own-secret', 'shape-secret', 'private', 'settings-secret', 'actor:far', 'item:hidden-loot', 'item:orphan']) assert.equal(wire.includes(secret), false, secret);

    // Delayed projection reads the captured frame, never the live positions after it was captured.
    game.players[0].x = far.x; game.players[0].y = far.y;
    const delayed = playerView(game, frame, own.id);
    assert.deepEqual(delayed.bodies.map(b => b.id), view.bodies.map(b => b.id));
  } finally { disposePhysics(game); }
});

test('live capture respects filtered hooks without mutating them and rejects detached state inputs', async () => {
  const withHook = content();
  withHook.roster.gladiators = [{ name: 'G', kit: 'hook' }];
  const game = await createGame(1, arena(), withHook);
  try {
    const r = physicsRuntime(game), caster = game.players[1];
    hookSkill(game, caster);
    r.hooks[0].targetIdx = game.players.length;
    const before = structuredClone(r.hooks);
    const filtered = capturePhysicsPresentation(game);
    assert.deepEqual(filtered.physics.hooks, []);
    assert.deepEqual(filtered.hookFlights, [], 'an omitted stale target cannot reappear as a live flight');
    assert.deepEqual(snapshot(game).hookFlights, []);
    assert.deepEqual(r.hooks, before, 'capture leaves hook fields and reserved identities untouched');

    r.hooks[0].targetIdx = undefined;
    const flying = capturePhysicsPresentation(game), retained = structuredClone(flying);
    assert.equal(flying.hookFlights[0].id, r.hooks[0].tetherId);
    assert.equal(flying.hookFlights[0].x, flying.physics.hooks[0].x);
    for (const state of [flying.physics, structuredClone(flying.physics), { ...flying.physics, hooks: [] }])
      assert.throws(() => capturePhysicsPresentation(game, state), /accepts only a live game/);
    r.hooks[0].x += 10;
    r.hooks[0].phase = 'pending';
    assert.deepEqual(capturePhysicsPresentation(game).hookFlights, []);
    assert.deepEqual(flying, retained, 'retained flights keep the captured coordinates and phase');
  } finally { disposePhysics(game); }
});

test('retained numeric captures and their clones keep body and tether identities after runtime replacement', async () => {
  const withHook = content();
  withHook.roster.gladiators = [{ name: 'G', kit: 'hook' }];
  const map = arena();
  map.spawns = [{ x: 250, y: 200 }]; map.hunterSpawns = [{ x: 150, y: 200 }];
  const game = await createGame(1, map, withHook);
  try {
    game.players.forEach(p => { p.bot = false; });
    setInput(game, 'g0', { seq: 1, skill: true, aim: 0 });
    step(game); step(game); step(game);
    const old = capturePhysicsPresentation(game), cloned = structuredClone(old);
    const expected = structuredClone(old), r = physicsRuntime(game), caster = game.players[1];
    assert.equal(old.tethers.length, 1);
    const bodyId = old.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === 1).id;
    const spec = old.physics.world.bodies.find(b => b.spec.id === 'actor:g0').spec;
    hookSkill(game, caster);
    r.world.queueRemoveBody(spec.id); r.world.commitMutations();
    assert.deepEqual(structuredClone(old), expected, 'removed live bodies remain in historical presentation');
    r.world.queueAddBody(spec); r.world.commitMutations();
    caster.cooldown = 0;
    hookSkill(game, caster);
    const fresh = capturePhysicsPresentation(game);
    assert.notEqual(fresh.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === 1).id, bodyId);
    assert.ok(fresh.hookFlights[0].id > old.tethers[0].id, 'same backend hook key has a new logical identity');
    assert.deepEqual(structuredClone(old), expected);
    assert.deepEqual(structuredClone(cloned), expected);
    assert.deepEqual(cloned.tethers, old.tethers, 'cloning numeric captures never allocates another identity');
    assert.throws(() => capturePhysicsPresentation(game, old.physics), /accepts only a live game/);
    assert.throws(() => capturePhysicsPresentation(game, structuredClone(old.physics)), /accepts only a live game/);
  } finally { disposePhysics(game); }
});

test('physics recording floor is explicit and stamped by the room writer', async () => {
  assert.equal(SCHEMA, 20);
  // Lines with delta frames (#901) need a reader of at least schema 17; this build still reads from MIN_SCHEMA.
  assert.equal(minimumReaderForMatch(), 20);
  assert.equal(MIN_SCHEMA, 10);
  let header;
  const service = createRoomService({ content, matchFactory: async (...args) => {
    const match = await createMatch(...args);
    // A future version must inherit the format floor through capability, without editing a version list.
    Object.defineProperty(match, 'version', { value: 'future-physics-rules' });
    return match;
  },
    replays: { start(h) { header = h; return { append() { return true; }, finish() { return {}; } }; } } });
  const created = service.makeRoom(1, false, undefined, arena()), room = service.rooms.get(created.id);
  try {
    await room.ready;
    const peer = service.connect({ deliver() { return true; }, close() {} });
    service.receive(peer, { type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant', name: 'Test' });
    service.receive(peer, { type: 'start' });
    assert.equal(header.schema, SCHEMA);
    assert.equal(header.minSchema, 20);
    assert.equal(header.version, 'future-physics-rules');
  } finally { await service.close(); }
});
