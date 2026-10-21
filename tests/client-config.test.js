import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { MATCHMAKING_COUNTDOWN_MS } from '../server/room-service.js';
import { MAX_ROOM_NAME, ROOM_SIZE_NAMES } from '../server/protocol.js';
import { listen } from './helpers/listen.js';
import { roomHarness, generatedMap } from './helpers/room-harness.js';
import { createGame, joinGame } from '../shared/simulation.ts';
import { MAX_ARENA_SEED, MAX_PLAYER_NAME } from '../shared/simulation/rules.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';

const injected = () => { const c = structuredClone(defaultContent()); c.id = 'config-content'; c.kits.warden.name = 'Guard'; return c; };

test('client configuration states each owner\'s values, the server\'s default content, and nothing of a room', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-config-'));
  const server = await createArenaServer({ replayDir: dir, generateMap: seed => Promise.resolve(generatedMap(seed)), content: injected });
  try {
    const base = await listen(server), post = name => fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 9, name }) });
    const room = await (await post('Configured')).json();
    const response = await fetch(base + '/api/client-config');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.deepEqual(config, {
      presentation: describeContent(injected()),
      seed: { min: 1, max: MAX_ARENA_SEED }, roomNameMaxLength: MAX_ROOM_NAME, playerNameMaxLength: MAX_PLAYER_NAME,
      sizes: ROOM_SIZE_NAMES, defaultSize: '12x6', matchmakingCountdownMs: MATCHMAKING_COUNTDOWN_MS,
    });
    const text = JSON.stringify(config);
    assert.ok(!text.includes(room.id) && !text.includes(room.ownerKey), 'no room or credential');

    // Room names count code points, so astral characters fit 24 where the old UTF-16 limit allowed 12.
    const astral = n => '\u{1F680}'.repeat(n);
    assert.equal(astral(24).length, 48);
    assert.equal((await post(astral(24))).status, 201);
    const refused = await post(astral(25));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /at most 24 characters/);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('player names keep the 16-unit cut and each layer keeps its own default name', async () => {
  const h = roomHarness({ reuseMaps: true }), room = h.service.makeRoom(9, false, undefined, generatedMap(9));
  try {
    const named = h.joined(room, { name: '\u{1F680}'.repeat(10) }), unnamed = h.joined(room, {}), blank = h.joined(room, { name: '   ' });
    const name = peer => room.seats.player(peer.session.playerId).name;
    assert.equal(name(named), '\u{1F680}'.repeat(8), 'sixteen UTF-16 code units');
    assert.equal(name(named).length, MAX_PLAYER_NAME);
    assert.deepEqual([name(unnamed), name(blank)], ['Player', 'Player'], 'the transport\'s default');
  } finally { await h.service.close(); }
  const s = createGame(4217);
  assert.equal(joinGame(s, 'direct')?.name, 'You', 'the simulation\'s own default');
});
