import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGenerator } from '../server/map-generator.js';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { roomHarness } from './helpers/room-harness.js';

test('the map worker returns exactly the map generated inline', async () => {
  const maps = createMapGenerator();
  try {
    const [first, second] = await Promise.all([maps.generate(4217, DEFAULT_LIVE_ZONE_SIZE), maps.generate(9, DEFAULT_LIVE_ZONE_SIZE)]);
    assert.equal(JSON.stringify(first), JSON.stringify(generateLiveMap(4217, defaultContent(), DEFAULT_LIVE_ZONE_SIZE)));
    assert.equal(JSON.stringify(second), JSON.stringify(generateLiveMap(9, defaultContent(), DEFAULT_LIVE_ZONE_SIZE)), 'requests are answered in their own order');
  } finally { await maps.close(); }
});

/** A generator whose maps arrive only when the test says, so the time between can be observed. */
function heldGenerator() {
  const held = [];
  const generateMap = (seed, size) => new Promise((resolve, reject) => held.push({ resolve: () => resolve(generateLiveMap(seed, defaultContent(), size)), reject }));
  return { generateMap, held };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
// The joins, a leave and a resume, in the order a lobby might see them.
function crowd(h, room) {
  const owner = h.joined(room, { ownerKey: room.ownerKey, name: 'Owner' });
  const striker = h.joined(room, { role: 'gladiator', kit: 'striker', name: 'Striker' });
  const gone = h.joined(room, { name: 'Gone' }); h.service.disconnect(gone.session);
  const late = h.joined(room, { name: 'Late' });
  const back = h.joined(room, { resumeKey: striker.messages.find(m => m.type === 'welcome').resumeKey });
  return { owner, striker, late, back };
}

test('a room is joinable while its map generates, and the seats it gave out are the ones live joins would', async () => {
  const { generateMap, held } = heldGenerator(), h = roomHarness({ generateMap });
  try {
    const room = h.directory.createRoom(9);
    assert.ok(room, 'the room exists before its map'); assert.equal(room.match, null); assert.equal(held.length, 1);
    assert.deepEqual(h.service.summaries().map(s => [s.id, s.phase, s.ready]), [[room.id, 'lobby', false]]);
    const { owner, striker, late, back } = crowd(h, room);
    const welcome = owner.messages.find(m => m.type === 'welcome');
    assert.equal(welcome.ready, false); assert.equal(welcome.map, null); assert.equal(welcome.state, null);
    assert.deepEqual(h.service.summaries()[0].players, { contestant: 2, gladiator: 1 });
    assert.equal(back.session.playerId, striker.session.playerId, 'a resume keeps its place');

    owner.send({ type: 'start' });
    assert.equal(room.started, false, 'the start waits for the map');
    assert.equal(owner.messages.findLast(m => m.type === 'lobby').starting, true);
    held[0].resolve(); await room.ready;
    assert.equal(room.started, true, 'and happens once it is ready');
    for (const peer of [owner, late, back]) {
      const ready = peer.messages.find(m => m.type === 'ready');
      assert.ok(ready.map.obstacles.length); assert.ok(ready.state.players.some(p => p.id === peer.session.playerId), 'in their own view');
    }

    // The same seed generated inline, with the same people arriving after it exists.
    const inline = roomHarness(), twin = inline.service.makeRoom(9);
    try {
      const people = crowd(inline, twin), ids = new Map([[owner, people.owner], [late, people.late], [back, people.back]]
        .map(([held, live]) => [live.session.playerId, held.session.playerId]));
      const rename = frame => JSON.parse(JSON.stringify(frame), (key, value) => ids.get(value) ?? value);
      assert.deepEqual(rename(twin.match.snapshot()), h.writers.get(room.id).frames[0].state, 'the first recorded frame is what live joins make');
    } finally { await inline.service.close(); }
  } finally { await h.service.close(); }
});

test('matchmakers share the room being generated, and its countdown waits for the map', async () => {
  const { generateMap, held } = heldGenerator(), h = roomHarness({ generateMap });
  try {
    const first = h.peer(), second = h.peer();
    first.send({ type: 'match', role: 'contestant' }); second.send({ type: 'match', role: 'any' });
    assert.equal(held.length, 1, 'one room for everyone matchmaking meanwhile');
    const room = first.session.room;
    assert.ok(room); assert.equal(second.session.room, room, 'both are admitted at once');
    assert.equal(first.messages.find(m => m.type === 'welcome').matchmade, true);
    for (let i = 0; i < 7; i++) assert.ok(h.directory.createRoom(9));
    assert.equal(h.directory.createRoom(9), null, 'a room still generating counts against the cap');
    h.wake(0, 15000); assert.equal(room.started, false, 'the countdown has run out, but there is no map');
    held[0].resolve(); await room.ready;
    h.wake(0); assert.equal(room.started, true);
  } finally { await h.service.close(); }
});

test('a room closed or retired while its map generates is never opened', async () => {
  const { generateMap, held } = heldGenerator(), h = roomHarness({ generateMap });
  const room = h.directory.createRoom(9); await h.service.close();
  held[0].resolve(); await room.ready;
  assert.equal(room.match, null);
});

test('a generator failure is reported, sends the room\'s players back, and frees the place', async () => {
  const { generateMap, held } = heldGenerator(), errors = [];
  const h = roomHarness({ generateMap, reportError: error => errors.push(error.message) });
  try {
    const player = h.peer(); player.send({ type: 'match' });
    const room = player.session.room;
    held[0].reject(new Error('generation broke')); await room.ready;
    assert.deepEqual(errors, ['generation broke']);
    assert.match(player.messages.at(-1).message, /could not be generated/);
    assert.equal(player.session.room, null); assert.equal(h.service.rooms.size, 0);
    player.send({ type: 'match' }); assert.ok(player.session.room, 'and the player can matchmake again');
    held[1].resolve(); await settle();
  } finally { await h.service.close(); }
});
