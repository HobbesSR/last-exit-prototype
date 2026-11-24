import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomService } from '../server/room-service.js';
import { contentById } from '../shared/simulation/content.ts';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { PHYSICS_VERSION, physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { SPECTATOR_DELAY_TICKS } from '../server/room-views.js';
import { openArea } from './helpers/arena.js';
import { readServerMessage } from '../shared/wire-schema.ts';

const VERSION = PHYSICS_VERSION;
const content = () => ({ ...structuredClone(contentById('content-6')),
  roster: { contestants: ['A'], gladiators: [] } });
const map = () => ({ seed: 449, width: 5000, height: 600,
  playableArea: openArea(5000, 600, 100),
  obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [],
  buildings: [], physicsProps: [{ id: 'hidden-prop', profile: 'crate', x: 4200, y: 300 }], motorSurfaces: [],
  entry: { x: 50, y: 300 }, exit: { x: 4900, y: 300 }, spawns: [{ x: 200, y: 300 }], hunterSpawns: [] });

function peer(service) {
  const messages = [], decoder = createLayerDecoder();
  let session;
  session = service.connect({ deliver(payload) {
    const message = readServerMessage(payload);
    if (message.type === 'state') message.decoded = decoder.decode(structuredClone(message.state));
    messages.push(message);
    return true;
  }, close() { service.disconnect(session); } });
  return { session, messages, send: message => service.receive(session, message) };
}

test('physics room pins mode at creation, withholds hidden dynamics, delays spectators, and rebuilds on reconnect', async () => {
  let header;
  const service = createRoomService({ content,
    replays: { start(value) { header = value; return { append() { return true; }, finish() { return {}; } }; } } });
  const created = service.makeRoom(449, false, undefined, map()), room = service.rooms.get(created.id);
  const owner = peer(service);
  try {
    await room.ready;
    owner.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'contestant' });
    const welcome = owner.messages.find(message => message.type === 'welcome');
    assert.ok(welcome?.resumeKey);

    const game = room.match.diagnosticState;
    const runtime = physicsRuntime(game);
    // Mode/version fields are untrusted protocol data. The room's creation-time factory owns both.
    owner.send({ type: 'start', mode: 'legacy', version: 'forged-version', contentId: 'content-1' });
    assert.equal(room.started, true);
    assert.equal(room.match.version, VERSION);
    assert.equal(header.version, VERSION);
    assert.equal(header.contentId, 'content-6');
    // The profile travels once, with the match map in the start's `ready` (24.3 proposal 3).
    assert.equal(owner.messages.findLast(message => message.type === 'ready').constants.physicsProfile, VERSION);
    const directed = owner.messages.filter(message => message.type === 'state').at(-1).decoded;
    assert.equal(directed.bodies.some(body => body.owner.kind === 'prop'), false,
      'out-of-range dynamics are not a local prediction dependency');
    assert.equal(JSON.stringify(directed).includes('hidden-prop'), false);

    // Move the owner midway through the spectator's delay window.
    for (let i = 0; i < SPECTATOR_DELAY_TICKS + 5; i++) {
      if (i === 5) assert.ok(room.match.teleport(welcome.id, 400, 300));
      service.advance(50, (i + 1) * 50);
    }
    const eye = peer(service);
    eye.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, mode: 'spectator' });
    const delayed = eye.messages.find(message => message.type === 'welcome').state;
    assert.equal(room.match.tick - delayed.tick, SPECTATOR_DELAY_TICKS, 'spectator joins on the retained delayed frame');
    assert.ok(Math.abs(delayed.bodies.find(body => body.owner.kind === 'prop').x - 4200) < 0.001);
    assert.ok(Math.abs(delayed.bodies.find(body => body.owner.kind === 'actor').x - 200) < 0.001);
    assert.ok(Math.abs(room.match.snapshot().bodies.find(body => body.owner.kind === 'actor').x - 400) < 0.001);

    const resumeKey = welcome.resumeKey;
    service.disconnect(owner.session);
    const resumed = peer(service);
    resumed.send({ type: 'join', room: room.id, ownerKey: room.ownerKey, resumeKey });
    assert.equal(resumed.session.playerId, welcome.id);
    service.advance(50, (SPECTATOR_DELAY_TICKS + 6) * 50);
    const keyframe = resumed.messages.filter(message => message.type === 'state').at(-1).state;
    assert.ok(keyframe.bodies && typeof keyframe.bodies === 'object' && 'all' in keyframe.bodies,
      'reconnected player receives a complete physics body keyframe');
    // A reconnect's welcome brings the profile again, with the map (24.3 proposal 3).
    assert.equal(resumed.messages.findLast(message => message.type === 'welcome').constants.physicsProfile, VERSION);
    assert.equal(keyframe.bodies.all.some(body => body.owner.kind === 'prop'), false);

    const world = runtime.world;
    resumed.send({ type: 'finish' });
    assert.throws(() => world.counts(), /disposed/);
  } finally {
    await service.close();
  }
});
