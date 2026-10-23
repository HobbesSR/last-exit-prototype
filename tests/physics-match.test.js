import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { contentById } from '../shared/simulation/content.ts';
import { createPhysicsGame, step, snapshot, disposePhysics, PHYSICS_VERSION, playerView, enqueuePhysicsImpulse } from '../shared/simulation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { insideMap } from '../shared/movement.ts';

const content = () => ({ ...structuredClone(contentById('content-1')), roster: { contestants: ['A'], gladiators: [] } });
const arena = (x = 0, y = 0) => ({ width: x + 600, height: y + 400, playableArea: { cellSize: 100, rows: Array.from({ length: (y + 400) / 100 }, (_, y) => ({ y, runs: [[0, (x + 600) / 100]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: x + 100, y: y + 200 }], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], modules: [], buildings: [], exit: { x: x + 550, y: y + 200 }, entry: { x: x + 50, y: y + 200 }, gaps: [] });

test('experimental match owns, isolates and disposes its world while retaining detached final frames', async () => {
  const a = await createPhysicsMatch(1, undefined, arena(), content());
  const b = await createPhysicsMatch(1, undefined, arena(), content());
  const world = physicsRuntime(a.diagnosticState).world;
  try {
    a.join('human', 'contestant'); b.join('human', 'contestant');
    assert.deepEqual(a.snapshot().physics.world.bodies.map(b => b.spec.id), ['actor:human'], 'join reconciles IDs before tick zero capture');
    assert.equal(a.snapshot().physics.world.bodies.some(b => b.spec.kind === 'static'), false);
    a.acceptInput('human', { x: 1, seq: 1 }); a.advance();
    assert.equal(a.version, PHYSICS_VERSION);
    assert.equal(b.tick, 0);
    assert.equal(a.snapshot().players[0].lastSeq, 1);
    assert.ok(a.snapshot().physics);
    assert.equal('physics' in a.project(a.snapshot(), 'human'), false, 'private engine state never enters live projection');
    a.dispose(); a.dispose();
    assert.throws(() => world.counts(), /disposed/);
    assert.throws(() => a.advance(), /disposed/);
    const frame = a.snapshot(); frame.players[0].hp = 0;
    assert.equal(a.snapshot().players[0].hp, 100);
    assert.equal(physicsRuntime(b.diagnosticState).world.counts().actors, 1);
  } finally { a.dispose(); b.dispose(); }
});

test('room composition awaits explicit physics factory, stamps pinned rules and disposes on shutdown', async () => {
  let header;
  const service = createRoomService({ content, matchFactory: createPhysicsMatch,
    replays: { start(h) { header = h; return { append() { return true; }, finish() { return {}; } }; } } });
  const room = service.makeRoom(1, false, undefined, arena());
  await room.ready;
  const world = physicsRuntime(room.game).world;
  const peer = service.connect({ deliver() { return true; }, close() {} });
  // Joining is the same public protocol as legacy; only server construction selects rules.
  service.receive(peer, { type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant', name: 'Test' });
  assert.ok(peer.room);
  service.receive(peer, { type: 'start' });
  await service.close();
  assert.equal(header.version, PHYSICS_VERSION);
  assert.throws(() => world.counts(), /disposed/);
});

test('mask contact remains contained at a distant live-map corner without leaking private state', async () => {
  const s = await createPhysicsGame(1, arena(51000, 25000), content());
  try {
    const p = s.players[0]; p.bot = false; p.input = { x: 1, y: 1 }; p.inputTick = 1000;
    for (let i = 0; i < 80; i++) { step(s); assert.ok(insideMap(s.map, p.x, p.y, 11.99)); }
    const frame = snapshot(s);
    assert.equal('physics' in playerView(s, frame, p.id), false);
    assert.equal(frame.physics.settings.exactCheckpoint, 'unsupported');
  } finally { disposePhysics(s); }
});

test('pending effects reject invalid values and cannot act on a teleported generation', async () => {
  const s = await createPhysicsGame(1, arena(), content());
  try {
    const p = s.players[0]; p.bot = false;
    const r = physicsRuntime(s), id = `actor:${p.id}`;
    assert.throws(() => enqueuePhysicsImpulse(s, id, { x: 1e308, y: 0 }), /representable/);
    assert.equal(r.pendingImpulses.length, 0);
    enqueuePhysicsImpulse(s, id, { x: 100, y: 0 });
    const previous = r.world.getGeneration(id);
    r.world.setTransform(id, { x: p.x, y: p.y, angle: 0 });
    assert.notEqual(r.world.getGeneration(id), previous);
    step(s);
    assert.equal(r.pendingImpulses.length, 0);
    assert.equal(p.movedThisTick, 0);
  } finally { disposePhysics(s); }
});
