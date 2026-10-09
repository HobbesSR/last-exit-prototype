import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createArenaServer, EMPTY_ROOM_GRACE_MS } from '../server/index.js';
import { listen } from './helpers/listen.js';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { generateLiveMap } from '../map/live.ts';

// A socket's layer decoder; a state frame read here is decoded as the client would (#250). Frames that
// arrive while nothing waits are not decoded, so read layers only from a session's first frame or keyframes.
const decoders = new WeakMap();
function next(ws, type, timeoutMs = 5000, accept = () => true) {
  if (!decoders.has(ws)) decoders.set(ws, createLayerDecoder());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function receive(raw) {
      const data = JSON.parse(raw);
      if (data.type === 'state') decoders.get(ws).decode(data.state);
      if (data.type === type && accept(data)) { clearTimeout(timer); ws.off('message', receive); resolve(data); }
    }
    ws.on('message', receive);
  });
}
/**
 * A private room whose map is ready. Rooms answer before their maps exist (#258); tests about other
 * things wait for it here, on the condition, under a generous cap: some seeds take tens of seconds (42).
 */
async function createRoom(server, base, body) {
  const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
  await server.rooms.get(room.id).ready; return room;
}

test('matchmaking separates private rooms, honors available preferences, falls back, and starts automatically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-match-'));
  const server = await createArenaServer({ replayDir: dir });
  try {
    const base = await listen(server);
    const privateRoom = await createRoom(server, base, '{"seed":9}');
    const clients = [], welcomes = [];
    for (const role of ['gladiator', 'gladiator', 'gladiator', 'gladiator', 'contestant', 'any']) {
      const ws = new WebSocket(base.replace('http:', 'ws:')); await new Promise(resolve => ws.once('open', resolve));
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
