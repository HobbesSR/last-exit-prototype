import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch } from '../server/match.js';
import { createRoomService } from '../server/room-service.js';
import { contentById } from '../shared/simulation/content.ts';
import { createGame, step, snapshot, disposePhysics, PHYSICS_VERSION, playerView, enqueuePhysicsImpulse, setInput } from '../shared/simulation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { admitPending } from '../shared/simulation/boundary.ts';
import { staticShapes } from '../shared/simulation/swept.ts';
import { insideMap } from '../shared/playable-area.ts';
import { stringifyWithMap } from '../server/map-payload.js';
import { replaceItem } from '../shared/simulation/ground-items.ts';
import { setDoor } from '../shared/simulation/doors.ts';
import { openArea } from './helpers/arena.js';
import { readServerMessage } from '../shared/wire-schema.ts';
import { stateOf } from '../shared/simulation/tick.ts';

const content = () => ({ ...structuredClone(contentById('content-7')), roster: { contestants: ['A'], gladiators: [] } });
const arena = (x = 0, y = 0) => ({ width: x + 600, height: y + 400, playableArea: openArea(x + 600, y + 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: x + 100, y: y + 200 }], stations: [], chargers: [], sensors: [], items: [], traps: [], buildings: [], exit: { x: x + 550, y: y + 200 }, entry: { x: x + 50, y: y + 200 }, gaps: [] });

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
    assert.equal(a.snapshot().physics, undefined);
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
  const created = service.makeRoom(1, false, undefined, arena()), room = service.rooms.get(created.id);
  await created.ready;
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
    assert.equal(typeof match.diagnosticState.items[0].id, 'number');
    assert.equal(initial.items[0].id, match.diagnosticState.items[0].id, 'delivered and recorded maps carry numeric item relations');
    assert.equal(old.items[0].id, initial.items[0].id, 'frames and map delivery share numeric item identity');
    check('live', stripped(match.map()));
    check('spectator', stripped(match.map(), { gates: match.map().gates.map((g, i) => ({ ...g, ...old.gates[i] })), items: old.items }), old);
    // Doors change through the core that keeps their state (#1214 stage 6a).
    setDoor(match.diagnosticState, 0, { open: true });
    replaceItem(match.diagnosticState, match.diagnosticState.items[0], { ...match.diagnosticState.items[0], x: 420 });
    match.diagnosticState.traps.push({ id: 'private-trap', x: 20, y: 20 });
    const current = check('recording', match.map());
    check('live', stripped(match.map()));
    const delayed = check('spectator', stripped(match.map(), { gates: match.map().gates.map((g, i) => ({ ...g, ...old.gates[i] })), items: old.items }), old);
    assert.equal(delayed.gates[0].open, false);
    assert.equal('x' in delayed.items[0], false, 'captured physical pose is carried only by its body');
    assert.deepEqual(delayed.traps, []);
    assert.equal('physicsProps' in delayed, false);
    assert.equal(initial.gates[0].open, false);
    assert.equal(initial.items[0].x, 400);
    assert.deepEqual(initial.traps, []);
    assert.equal(current.traps.length, 1);
    assert.throws(() => current.items.pop(), TypeError);
    assert.throws(() => current.items[0].x = 0, TypeError);
    assert.equal(match.map().items[0].x, 420);
    const finalFrame = match.snapshot();
    match.dispose();
    assert.throws(() => match.payloadMap('recording'), /disposed/);
    assert.throws(() => match.payloadMap('live'), /disposed/);
    assert.throws(() => match.payloadMap('spectator', finalFrame), /disposed/);
    assert.equal(match.map().items[0].x, 420);
    assert.equal(match.snapshot().tick, finalFrame.tick);
  } finally { match.dispose(); }
});

// After the start the game holds the roster, never the match's state (27.2 "Test API"). Each stale write below is one the
// mirror used to overwrite and that no longer reaches anything (review 1108 on #1355).
test('a started match seats joins and builds the live map from the core, not from the game', async () => {
  const fourContestants = { ...content(), roster: { contestants: ['A', 'B', 'C', 'D'], gladiators: [] } };
  const map = { ...arena(200), gates: [{ id: 'gate', x: 700, y: 100, w: 20, h: 20, kind: 'door', open: false, locked: false }],
    spawns: [{ x: 100, y: 100 }, { x: 100, y: 300 }, { x: 300, y: 100 }, { x: 300, y: 300 }], items: [{ id: 'cell', x: 500, y: 200, kind: 'cell', charge: 0 }] };
  const match = await createMatch(1, undefined, map, fourContestants), game = match.diagnosticState;
  try {
    game.players[0].status = 'eliminated';
    match.start(); match.advance();
    // c0 is eliminated in the core. The game's record is made to say otherwise, as an elimination after the start leaves it.
    game.players[0].status = 'active';
    assert.equal(match.openPlaces('contestant'), 3);
    assert.equal(match.join('live', 'contestant').id, 'live');
    assert.equal(game.players[1].id, 'live', 'a join takes the first place the core holds active, not an eliminated one');
    // Two recorded joins in one tick take two places: the first's change of controller counts at once.
    const join = id => ({ type: 'join', id, role: 'contestant', kit: game.players[2].kit, name: id });
    assert.equal(match.replay([join('r1'), join('r2')]), true);
    assert.deepEqual(stateOf(game).players.map(p => [p.id, p.status]), [['c0', 'eliminated'], ['live', 'active'], ['r1', 'active'], ['r2', 'active']]);
    assert.equal(match.openPlaces('contestant'), 0);
    assert.equal(match.join('late', 'contestant'), null, 'no active place of the role is left to take');

    replaceItem(game, game.items[0], { ...game.items[0], x: 999 });
    setDoor(game, 0, { open: true });
    const [held] = stateOf(game).items, live = match.payloadMap('live', match.frame());
    assert.deepEqual([live.items[0].id, live.items[0].x, live.items[0].y], [held.id, held.x, held.y], 'the live map has each item where the match has it');
    assert.equal(live.gates[0].open, false, 'and each gate as the match has it');
    assert.deepEqual(match.map().items.map(i => i.x), [held.x]);
    game.traps.push({ id: 'stale-trap', x: 20, y: 20 });
    assert.deepEqual(match.map().traps, match.frame().traps, 'the map query has the traps as the match has them');
  } finally { match.dispose(); }
});

test('room welcomes and recording start use prepared maps without changing start or command ordering', async () => {
  let match, header;
  const frames = [], messages = [];
  const service = createRoomService({ devTools: 'all', content,
    matchFactory: async (...args) => {
      match = await createMatch(...args);
      return { ...match, acceptSanitizedInput: undefined, map() { throw new Error('full map clone'); } };
    },
    replays: { start(value) { header = structuredClone(value); return {
      append(state, commands) { frames.push(structuredClone({ state, commands })); return true; }, finish() { return {}; }
    }; } }
  });
  const created = service.makeRoom(1, false, undefined, arena()), room = service.rooms.get(created.id);
  const player = service.connect({ deliver(message) { messages.push(readServerMessage(message)); return true; }, close() {} });
  service.receive(player, { type: 'join', room: created.id, ownerKey: created.ownerKey, name: 'Player' });
  service.receive(player, { type: 'start' });
  try {
    assert.notEqual(messages[0].map.width, 600, 'player first sees the waiting yard, not the match map');
    await created.ready;
    assert.equal(room.started, true);
    const ready = messages.find(message => message.type === 'ready');
    assert.deepEqual(ready.map, match.payloadMap('live'));
    assert.deepEqual(header.map, match.map());
    assert.deepEqual(frames[0].commands.map(command => command.type), ['join', 'start']);
    assert.equal(frames[0].state.tick, 0);
    service.receive(player, { type: 'input', tick: 1, seq: 0, x: 1 });
    service.advance(50, 50);
    assert.deepEqual(frames.at(-1).commands.map(command => [command.type, command.seq]), [['command', 0]],
      'a factory with only acceptInput still admits and records input');
    const watcher = service.connect({ deliver(message) { messages.push(readServerMessage(message)); return true; }, close() {} });
    service.receive(watcher, { type: 'join', room: room.id, mode: 'dev' });
    assert.deepEqual(messages.at(-1).map, match.payloadMap('spectator', match.snapshot()));
  } finally { await service.close(); }
});

test('cooperative physics preparation yields between static geometry batches without changing the match trace', async () => {
  const map = arena();
  map.obstacles = Array.from({ length: 520 }, (_, i) => ({ id: `obstacle-${String(519 - i).padStart(4, '0')}`,
    x: 300 + (i % 20) * 10, y: 20 + Math.floor(i / 20) * 10, w: 3, h: 3 }));
  let opportunities = 0;
  const pause = async () => { await new Promise(resolve => setTimeout(resolve, 0)); opportunities++; };
  const synchronous = await createGame(9, structuredClone(map), content());
  let cooperative;
  try {
    cooperative = await createGame(9, structuredClone(map), content(), pause);
    assert.ok(opportunities > 1, 'preparation yielded to timer callbacks');
    assert.equal(synchronous.tick, 0);
    assert.equal(cooperative.tick, 0, 'preparation never steps the match');
    const bodies = game => physicsRuntime(game).world.snapshot({ includeStatic: true }).bodies.map(({ spec, generation }) => [spec.id, generation]);
    assert.deepEqual(bodies(cooperative), bodies(synchronous), 'native body generation order is unchanged');
    for (const policy of [true, false]) assert.deepEqual(staticShapes(cooperative.map, policy), staticShapes(synchronous.map, policy), 'sweep source order differs from native ID order');
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

test('a ready server match has both sweep indexes on its exact map before its first sweep', async () => {
  const map = arena();
  let reads = 0;
  map.obstacles.push({ id: 'wall', kind: 'building', get x() { reads++; return 300; }, y: 20, w: 10, h: 20 });
  const match = await createMatch(9, undefined, map, content());
  try {
    assert.equal(match.diagnosticState.map, map);
    reads = 0;
    for (const policy of [true, false]) assert.ok(staticShapes(map, policy).length > 0);
    assert.equal(reads, 0, 'neither first sweep reconstructs the static geometry');
  } finally { match.dispose(); }
});

test('room shutdown during cooperative construction awaits and disposes the unadopted world', async () => {
  let world;
  const factory = (...args) => createMatch(...args).then(match => {
    world = physicsRuntime(match.diagnosticState).world;
    return match;
  });
  const service = createRoomService({ content, matchFactory: factory,
    replays: { start() { return { append() { return true; }, finish() { return {}; } }; } } });
  const created = service.makeRoom(1, false, undefined, arena()), room = service.rooms.get(created.id);
  const messages = [];
  const peer = service.connect({ deliver(message) { messages.push(readServerMessage(message)); return true; }, close() {} });
  service.receive(peer, { type: 'join', room: created.id, ownerKey: created.ownerKey, role: 'contestant', name: 'Test' });
  service.receive(peer, { type: 'start' });

  const firstClose = service.close();
  assert.equal(service.close(), firstClose, 'repeated close shares the pending shutdown');
  await firstClose;
  assert.ok(world, 'factory completed while close awaited initialization');
  assert.equal(room.match, null, 'closing room never adopts the completed match');
  assert.equal(room.started, false, 'deferred start is not run after close');
  assert.equal(messages.some(message => message.type === 'ready'), false, 'no ready frame is sent for the unadopted match');
  assert.throws(() => world.counts(), /disposed/);
  await created.ready;
});

test('mask contact remains contained at a distant live-map corner without leaking private state', async () => {
  const s = await createGame(1, arena(51000, 25000), content());
  try {
    const p = s.players[0]; p.bot = false;
    for (let i = 0; i < 80; i++) {
      assert.ok(setInput(s, p.id, { seq: i + 1, x: 1, y: 1 }));
      step(s);
      assert.ok(insideMap(s.map, p.x, p.y, s.content.actorPhysics.geometry.contestant.bodyRadius - 0.05), 'contact stays within solver slop');
    }
    const frame = snapshot(s);
    assert.equal('physics' in playerView(s, frame, p.id), false);
    assert.equal(physicsRuntime(s).world.settings.exactCheckpoint, 'unsupported');
    assert.equal(frame.physics, undefined);
    assert.ok(frame.bodies.some(body => body.owner.kind === 'actor'));
  } finally { disposePhysics(s); }
});

test('pending effects reject invalid values and cannot act on a teleported generation', async () => {
  const s = await createGame(1, arena(), content());
  try {
    const p = s.players[0]; p.bot = false;
    const r = physicsRuntime(s), id = `actor:${p.id}`;
    assert.throws(() => enqueuePhysicsImpulse(s, id, { x: 1e308, y: 0 }), /representable/);
    assert.equal(r.pendingImpulses.length, 0);
    enqueuePhysicsImpulse(s, id, { x: 100, y: 0 });
    const previous = r.world.getGeneration(id);
    r.world.setTransform(id, { x: p.x, y: p.y, angle: 0 });
    assert.notEqual(r.world.getGeneration(id), previous);
    admitPending(s, r);
    assert.equal(r.pendingImpulses.length, 0);
    assert.equal(r.world.step().distance[id], 0);
  } finally { disposePhysics(s); }
});
