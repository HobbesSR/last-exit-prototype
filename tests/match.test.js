import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { contentById } from '../shared/simulation/content.ts';
import { createPhysicsGame, step, snapshot, disposePhysics, PHYSICS_VERSION, playerView, enqueuePhysicsImpulse, setInput } from '../shared/simulation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { insideMap } from '../shared/movement.ts';
import { stringifyWithMap } from '../server/map-payload.js';
import { replaceItem } from '../shared/simulation/ground-items.ts';

const content = () => ({ ...structuredClone(contentById('content-7')), roster: { contestants: ['A'], gladiators: [] } });
const arena = (x = 0, y = 0) => ({ width: x + 600, height: y + 400, playableArea: { cellSize: 100, rows: Array.from({ length: (y + 400) / 100 }, (_, y) => ({ y, runs: [[0, (x + 600) / 100]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: x + 100, y: y + 200 }], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], modules: [], buildings: [], exit: { x: x + 550, y: y + 200 }, entry: { x: x + 50, y: y + 200 }, gaps: [] });

test('experimental match owns, isolates and disposes its world while retaining detached final frames', async () => {
  const a = await createMatch(1, undefined, arena(), content());
  const b = await createMatch(1, undefined, arena(), content());
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
  const service = createRoomService({ content,
    replays: { start(h) { header = h; return { append() { return true; }, finish() { return {}; } }; } } });
  const room = service.makeRoom(1, false, undefined, arena());
  await room.ready;
  const world = physicsRuntime(room.game).world;
  const peer = service.connect({ deliver() { return true; }, close() {} });
  // Match admission and room creation share the public room protocol.
  service.receive(peer, { type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant', name: 'Test' });
  assert.ok(peer.room);
  service.receive(peer, { type: 'start' });
  await service.close();
  assert.equal(header.version, PHYSICS_VERSION);
  assert.throws(() => world.counts(), /disposed/);
});

test('prepared map payloads match detached map queries at live and historical boundaries', async () => {
  const map = arena();
  map.gates.push({ id: 'gate', x: 300, y: 100, w: 20, h: 20, kind: 'door', open: false, locked: false });
  map.items.push({ id: 'cell', x: 400, y: 200, kind: 'cell', charge: 0 });
  map.physicsProps = [{ id: 'authored', x: 450, y: 250, profile: 'crate' }];
  const match = await createMatch(1, undefined, map, content());
  try {
    const old = match.snapshot();
    const check = (kind, expected, frame) => {
      const payload = match.payloadMap(kind, frame);
      assert.equal(stringifyWithMap({ type: 'ready', map: payload }), JSON.stringify({ type: 'ready', map: expected }));
      assert.deepEqual(payload, expected);
      return payload;
    };
    const stripped = (source, overrides = {}) => {
      const copy = structuredClone({ ...source, traps: [], ...overrides });
      delete copy.physicsProps;
      return copy;
    };
    const initial = check('recording', match.map());
    check('live', stripped(match.map()));
    check('spectator', stripped(match.map(), { gates: old.gates, items: old.items }), old);
    map.gates[0].open = true;
    replaceItem(match.diagnosticState, map.items[0], { ...map.items[0], x: 420 });
    map.traps.push({ id: 'private-trap', x: 20, y: 20 });
    const current = check('recording', match.map());
    check('live', stripped(match.map()));
    const delayed = check('spectator', stripped(match.map(), { gates: old.gates, items: old.items }), old);
    assert.equal(delayed.gates[0].open, false);
    assert.equal(delayed.items[0].x, 400);
    assert.deepEqual(delayed.traps, []);
    assert.equal('physicsProps' in delayed, false);
    assert.equal(initial.gates[0].open, false);
    assert.equal(initial.items[0].x, 400);
    assert.deepEqual(initial.traps, []);
    assert.equal(current.traps.length, 1);
    assert.throws(() => current.items.pop(), TypeError);
    assert.throws(() => current.items[0].x = 0, TypeError);
    assert.equal(match.map().items[0].x, 420);
  } finally { match.dispose(); }
});

test('room welcomes and recording start use prepared maps without changing start or command ordering', async () => {
  let match, header;
  const frames = [], messages = [];
  const service = createRoomService({ devTools: 'all', content,
    matchFactory: async (...args) => {
      match = await createMatch(...args);
      return { ...match, map() { throw new Error('full map clone'); } };
    },
    replays: { start(value) { header = structuredClone(value); return {
      append(state, commands) { frames.push(structuredClone({ state, commands })); return true; }, finish() { return {}; }
    }; } }
  });
  const room = service.makeRoom(1, false, undefined, arena());
  const player = service.connect({ deliver(message) { messages.push(JSON.parse(message)); return true; }, close() {} });
  service.receive(player, { type: 'join', room: room.id, ownerKey: room.ownerKey, name: 'Player' });
  service.receive(player, { type: 'start' });
  try {
    assert.notEqual(messages[0].map.width, 600, 'player first sees the waiting yard, not the match map');
    await room.ready;
    assert.equal(room.started, true);
    const ready = messages.find(message => message.type === 'ready');
    assert.deepEqual(ready.map, match.payloadMap('live'));
    assert.deepEqual(header.map, match.map());
    assert.deepEqual(frames[0].commands.map(command => command.type), ['join', 'start']);
    assert.equal(frames[0].state.tick, 0);
    const watcher = service.connect({ deliver(message) { messages.push(JSON.parse(message)); return true; }, close() {} });
    service.receive(watcher, { type: 'join', room: room.id, role: 'dev' });
    assert.deepEqual(messages.at(-1).map, match.payloadMap('spectator', match.snapshot()));
  } finally { await service.close(); }
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
  const factory = (...args) => createMatch(...args).then(match => {
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
