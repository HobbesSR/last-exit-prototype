import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { contentById } from '../shared/simulation/content.ts';
import { createPhysicsGame, step, snapshot, disposePhysics, PHYSICS_VERSION, playerView, enqueuePhysicsImpulse, setInput } from '../shared/simulation.ts';
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

test('cooperative physics preparation yields between static geometry batches without changing the match trace', async () => {
  const map = arena();
  map.obstacles = Array.from({ length: 520 }, (_, i) => ({ id: `obstacle-${String(i).padStart(4, '0')}`,
    x: 300 + (i % 20) * 10, y: 20 + Math.floor(i / 20) * 10, w: 3, h: 3 }));
  let opportunities = 0;
  const pause = async () => { await new Promise(resolve => setTimeout(resolve, 0)); opportunities++; };
  const synchronous = await createPhysicsGame(9, structuredClone(map), content());
  let cooperative;
  try {
    cooperative = await createPhysicsGame(9, structuredClone(map), content(), pause);
    assert.ok(opportunities > 1, 'preparation yielded to timer callbacks');
    assert.equal(synchronous.tick, 0);
    assert.equal(cooperative.tick, 0, 'preparation never steps the match');
    const bodies = game => physicsRuntime(game).world.snapshot({ includeStatic: true }).bodies.map(({ spec, generation }) => [spec.id, generation]);
    assert.deepEqual(bodies(cooperative), bodies(synchronous), 'native body generation order is unchanged');
    assert.deepEqual(snapshot(cooperative), snapshot(synchronous), 'initial captured frames are unchanged');

    for (let tick = 1; tick <= 3; tick++) {
      for (const game of [synchronous, cooperative]) {
        const player = game.players[0]; player.bot = false;
        assert.ok(setInput(game, player.id, { x: tick % 2 ? 1 : 0, y: tick % 2 ? 0 : 1, seq: tick }));
        step(game);
      }
      const a = snapshot(synchronous), b = snapshot(cooperative);
      assert.equal(b.tick, tick);
      assert.deepEqual(b, a, `frame after tick ${tick}`);
      assert.deepEqual(playerView(cooperative, b, 'c0'), playerView(synchronous, a, 'c0'), `projection after tick ${tick}`);
    }
  } finally { disposePhysics(synchronous); if (cooperative) disposePhysics(cooperative); }
});

test('room shutdown during cooperative construction awaits and disposes the unadopted world', async () => {
  let world;
  const factory = (...args) => createPhysicsMatch(...args).then(match => {
    world = physicsRuntime(match.diagnosticState).world;
    return match;
  });
  const service = createRoomService({ content, matchFactory: factory,
    replays: { start() { return { append() { return true; }, finish() { return {}; } }; } } });
  const room = service.makeRoom(1, false, undefined, arena());
  const messages = [];
  const peer = service.connect({ deliver(message) { messages.push(JSON.parse(message)); return true; }, close() {} });
  service.receive(peer, { type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant', name: 'Test' });
  service.receive(peer, { type: 'start' });

  const firstClose = service.close();
  assert.equal(service.close(), firstClose, 'repeated close shares the pending shutdown');
  await firstClose;
  assert.ok(world, 'factory completed while close awaited initialization');
  assert.equal(room.match, null, 'closing room never adopts the completed match');
  assert.equal(room.started, false, 'deferred start is not run after close');
  assert.equal(messages.some(message => message.type === 'ready'), false, 'no ready frame is sent for the unadopted match');
  assert.throws(() => world.counts(), /disposed/);
  await room.ready;
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
