import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROOMS } from '../server/room-directory.js';
import { roomHarness } from './helpers/room-harness.js';

test('a room summary is plain public data: kind, phase, size, players and open places by role', async () => {
  const h = roomHarness();
  try {
    const player = h.peer(); player.send({ type: 'match', role: 'gladiator', name: 'G' });
    const room = player.session.room, [summary] = h.service.summaries();
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary, 'survives the wire unchanged');
    assert.equal(summary.id, room.id); assert.equal(summary.kind, 'matchmade'); assert.equal(summary.phase, 'lobby');
    assert.equal(summary.size, '12x6'); assert.equal(summary.createdAt, room.createdAt);
    assert.deepEqual(summary.players, { contestant: 0, gladiator: 1 });
    assert.deepEqual(summary.open, { contestant: room.match.capacity('contestant'), gladiator: room.match.capacity('gladiator') - 1 });
    assert.ok(!JSON.stringify(summary).includes(room.ownerKey), 'never the owner key');
  } finally { await h.service.close(); }
});

test('everyone sees matchmade rooms still filling; private and live rooms only when dev tools admit everyone', async () => {
  for (const devTools of ['none', 'owner', 'all']) {
    const h = roomHarness({ devTools });
    try {
      const priv = h.directory.createRoom(9), player = h.peer(); player.send({ type: 'match' });
      const matchmade = player.session.room, listed = () => h.directory.list().map(room => room.id).sort();
      assert.deepEqual(listed(), devTools === 'all' ? [priv.id, matchmade.id].sort() : [matchmade.id], devTools);
      h.wake(0, 15000); assert.equal(matchmade.started, true);
      assert.deepEqual(listed(), devTools === 'all' ? [priv.id, matchmade.id].sort() : [], `${devTools}: live`);
      if (devTools === 'all') assert.equal(h.directory.list().find(room => room.id === matchmade.id).phase, 'live');
      h.service.disconnect(player.session); h.wake(0); h.wake(0, 30000); assert.equal(matchmade.finished, true);
      assert.ok(!listed().includes(matchmade.id), `${devTools}: a finished room leaves the list`);
    } finally { await h.service.close(); }
  }
});

test('matchmaking fills one room until no place is open, then makes another', async () => {
  const h = roomHarness();
  try {
    const first = h.peer(); first.send({ type: 'match' });
    const room = first.session.room, places = room.match.capacity('contestant') + room.match.capacity('gladiator');
    for (let i = 1; i < places; i++) { const p = h.peer(); p.send({ type: 'match', role: 'gladiator' }); assert.equal(p.session.room, room); }
    assert.deepEqual(h.service.summaries()[0].open, { contestant: 0, gladiator: 0 });
    const overflow = h.peer(); overflow.send({ type: 'match' });
    assert.ok(overflow.session.room); assert.notEqual(overflow.session.room, room);
    assert.equal(h.directory.match(), overflow.session.room.id, 'the answer is a room id');
  } finally { await h.service.close(); }
});

test(`the directory holds at most ${MAX_ROOMS} rooms, and a finished one frees its place`, async () => {
  const h = roomHarness();
  try {
    const rooms = Array.from({ length: MAX_ROOMS }, () => h.directory.createRoom(9));
    assert.ok(rooms.every(Boolean)); assert.equal(h.directory.hasCapacity(), false); assert.equal(h.directory.createRoom(9), null);
    const refused = h.peer(); refused.send({ type: 'match' });
    assert.match(refused.messages.at(-1).message, /All arena slots are occupied/);
    const owner = h.joined(rooms[0], { ownerKey: rooms[0].ownerKey }); owner.send({ type: 'start' }); owner.send({ type: 'finish' });
    assert.ok(h.directory.createRoom(9));
  } finally { await h.service.close(); }
});
