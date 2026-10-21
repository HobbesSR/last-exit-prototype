import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';
import { next, open, createRoom } from './helpers/arena-socket.js';

test('matchmaking separates private rooms, honors available preferences, falls back, and starts automatically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-match-'));
  const server = await createArenaServer({ replayDir: dir });
  try {
    const base = await listen(server);
    const privateRoom = await createRoom(server, base, '{"seed":9}');
    const clients = [], welcomes = [];
    for (const role of ['gladiator', 'gladiator', 'gladiator', 'gladiator', 'contestant', 'any']) {
      const ws = await open(base);
      const welcome = next(ws, 'welcome'); ws.send(JSON.stringify({ type: 'match', role, name: 'Queued' }));
      clients.push(ws); welcomes.push(await welcome);
    }
    const roomId = welcomes[0].room;
    assert.notEqual(roomId, privateRoom.id);
    assert.ok(welcomes.every(w => w.room === roomId && !w.owner));
    const room = server.rooms.get(roomId); assert.equal(room.started, false);
    assert.deepEqual(welcomes.map(w => room.seats.player(w.id).role), ['gladiator', 'gladiator', 'gladiator', 'contestant', 'contestant', 'contestant']);
    const listed = await (await fetch(base + '/api/rooms')).json();
    assert.deepEqual(listed.map(r => [r.id, r.kind, r.phase]), [[roomId, 'matchmade', 'lobby']], 'the private room is reached by link, not listed');
    assert.deepEqual(listed[0].players, { contestant: 3, gladiator: 3 });
    await room.ready;
    // A lobby frame can already be queued on the socket when readiness resolves.
    const live = next(clients[0], 'state', 5000, frame => frame.state.phase === 'live'); room.startsAt = Date.now() - 1;
    assert.equal((await live).state.phase, 'live'); assert.equal(room.started, true);
    assert.deepEqual(await (await fetch(base + '/api/rooms')).json(), [], 'a started room leaves the list');
    clients.forEach(ws => ws.close());
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
