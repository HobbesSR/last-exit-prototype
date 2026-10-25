import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomService } from '../server/room-service.js';
import { createPhysicsMatch } from '../server/match.js';
import { contentById } from '../shared/simulation/content.ts';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { SPECTATOR_DELAY_TICKS } from '../server/room-views.js';

const VERSION = 'last-exit-0.8-physics-8';
const content = () => ({ ...structuredClone(contentById('content-physics-8')),
  roster: { contestants: ['A'], gladiators: [] } });
const map = () => ({ seed: 449, width: 5000, height: 600,
  playableArea: { cellSize: 100, rows: Array.from({ length: 6 }, (_, y) => ({ y, runs: [[0, 50]] })) },
  obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [],
  routes: [], nodes: [], streets: [], modules: [], buildings: [], physicsProps: [], motorSurfaces: [],
  entry: { x: 50, y: 300 }, exit: { x: 4900, y: 300 }, spawns: [{ x: 200, y: 300 }], hunterSpawns: [] });

function peer(service) {
  const messages = [], decoder = createLayerDecoder();
  let session;
  session = service.connect({ deliver(payload) {
    const message = JSON.parse(payload);
    if (message.type === 'state') message.decoded = decoder.decode(structuredClone(message.state));
    messages.push(message);
    return true;
  }, close() { service.disconnect(session); } });
  return { session, messages, send: message => service.receive(session, message) };
}

test('physics room pins mode at creation, withholds hidden dynamics, delays spectators, and rebuilds on reconnect', async () => {
  let header;
  const service = createRoomService({ content, matchFactory: createPhysicsMatch,
    replays: { start(value) { header = value; return { append() { return true; }, finish() { return {}; } }; } } });
  const room = service.makeRoom(449, false, undefined, map());
  const owner = peer(service);
  try {
    await room.ready;
    owner.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant' });
    const welcome = owner.messages.find(message => message.type === 'welcome');
    assert.ok(welcome?.resumeKey);
    assert.equal(room.match.hasPhysics, true);

    const game = room.match.diagnosticState;
    const runtime = physicsRuntime(game);
    runtime.world.queueAddBody({ id: 'hidden-prop', kind: 'prop', shape: { kind: 'circle', radius: 12 },
      x: 4200, y: 300, vx: 0, vy: 0, angle: 0, omega: 0, mass: 1 });
    runtime.world.commitMutations();

    // Mode/version fields are untrusted protocol data. The room's creation-time factory owns both.
    owner.send({ type: 'start', mode: 'legacy', version: 'forged-version', contentId: 'content-1' });
    assert.equal(room.started, true);
    assert.equal(room.match.hasPhysics, true);
    assert.equal(room.match.version, VERSION);
    assert.equal(header.version, VERSION);
    assert.equal(header.contentId, 'content-physics-8');
    assert.equal(owner.messages.at(-1).state.physicsProfile, VERSION);
    const directed = owner.messages.filter(message => message.type === 'state').at(-1).decoded;
    assert.equal(directed.bodies.some(body => body.id === 'hidden-prop'), false,
      'out-of-range dynamics are not a local prediction dependency');
    assert.equal(JSON.stringify(directed).includes('hidden-prop'), false);

    // Move a dynamic body as the server advances; an ordinary spectator must receive its retained pose.
    let x = 4200;
    for (let i = 0; i < SPECTATOR_DELAY_TICKS + 5; i++) {
      x += 1;
      runtime.world.setTransform('hidden-prop', { x, y: 300, angle: 0 });
      service.advance(50, (i + 1) * 50);
    }
    const eye = peer(service);
    eye.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'spectator' });
    const delayed = eye.messages.find(message => message.type === 'welcome').state;
    assert.equal(room.match.tick - delayed.tick, SPECTATOR_DELAY_TICKS, 'spectator joins on the retained delayed frame');
    assert.equal(delayed.bodies.find(body => body.id === 'hidden-prop').x, 4205);
    assert.equal(room.match.snapshot().bodies.find(body => body.id === 'hidden-prop').x, x);

    const resumeKey = welcome.resumeKey;
    service.disconnect(owner.session);
    const resumed = peer(service);
    resumed.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, resumeKey });
    assert.equal(resumed.session.playerId, welcome.id);
    service.advance(50, (SPECTATOR_DELAY_TICKS + 6) * 50);
    const keyframe = resumed.messages.filter(message => message.type === 'state').at(-1).state;
    assert.ok(keyframe.bodies && typeof keyframe.bodies === 'object' && 'all' in keyframe.bodies,
      'reconnected player receives a complete physics body keyframe');
    assert.equal(keyframe.physicsProfile, VERSION);
    assert.equal(keyframe.bodies.all.some(body => body.id === 'hidden-prop'), false);

    const world = runtime.world;
    resumed.send({ type: 'finish' });
    assert.throws(() => world.counts(), /disposed/);
  } finally {
    await service.close();
  }
});
