import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRoomService } from '../server/room-service.js';
import { createFileReplayStore } from '../server/replay-store.js';
import { startScheduler } from '../server/scheduler.js';
import { CLOSE_REASON } from '../server/protocol.js';
import { createLayerDecoder } from '../shared/frame-layers.ts';
import { generatedMap } from './helpers/room-harness.js';
import { readArchive } from './helpers/recordings.js';

// The room lifecycle (room.js) run on both hosts of it: every room in this thread, and each on its own
// worker thread (#1089), through the same scenarios. Maps are the pregenerated arena, never generated here.

async function until(condition, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

/** A room service of either kind over a temp archive, on real time, torn down by `finish()`. */
async function host(threads) {
  const dir = await mkdtemp(path.join(tmpdir(), 'room-hosts-'));
  const replays = await createFileReplayStore(dir), errors = [];
  const service = createRoomService({ replays, threads, devTools: 'all', reportError: error => errors.push(error) });
  const stop = startScheduler(service.advance);
  const peer = () => {
    const messages = [], closes = [], layers = createLayerDecoder(), frames = [];
    const deliver = payload => {
      const data = JSON.parse(payload); messages.push(data);
      if (data.type === 'state') frames.push(layers.decode(data.state));
    };
    const session = service.connect({ deliver, close: (...args) => { closes.push(args); service.disconnect(session); } });
    const p = {
      session, messages, closes, frames,
      send: message => service.receive(session, message),
      welcome: () => messages.find(m => m.type === 'welcome'),
      has: type => messages.some(m => m.type === type),
    };
    return p;
  };
  const join = (room, extra = {}) => { const p = peer(); p.send({ type: 'join', room: room.id, ...extra }); return p; };
  let finished = false;
  const finish = async () => {
    if (finished) return; finished = true;
    stop(); await service.close(); await rm(dir, { recursive: true, force: true });
  };
  return { dir, replays, service, errors, peer, join, finish };
}

/** A map the test releases or fails when it says. */
function heldMap() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, release: () => resolve(generatedMap(9)), fail: error => reject(error) };
}

const laterRoles = service => service.summaries()[0]?.players;
const inRoom = (service, id) => service.summaries().some(s => s.id === id);

for (const threads of [false, true]) {
  const label = threads ? 'threads' : 'inline';

  test(`roster commands replay on the map, and the match plays to a saved archive (${label})`, async () => {
    const h = await host(threads);
    try {
      const held = heldMap(), room = h.service.makeRoom(9, false, undefined, held.promise);
      const owner = h.join(room, { ownerKey: room.ownerKey, name: 'Owner' });
      const striker = h.join(room, { role: 'gladiator', kit: 'striker', name: 'Striker' });
      const gone = h.join(room, { name: 'Gone' });
      await until(() => gone.has('welcome') && owner.has('welcome') && striker.has('welcome'), 'first welcomes');
      h.service.disconnect(gone.session);
      const late = h.join(room, { name: 'Late' });
      await until(() => late.has('welcome'), 'late welcome');
      late.send({ type: 'choose', role: 'gladiator', kit: 'specter' });
      owner.send({ type: 'choose', role: 'gladiator' }); owner.send({ type: 'choose', role: 'contestant' });
      const back = h.join(room, { resumeKey: striker.welcome().resumeKey });
      await until(() => back.has('welcome'), 'resumed welcome');

      assert.equal(owner.welcome().ready, false, 'the owner waits in the yard');
      assert.equal(back.welcome().id, striker.welcome().id, 'a resume keeps its place');
      await until(() => laterRoles(h.service)?.gladiator === 2 && laterRoles(h.service)?.contestant === 1, 'the roster in the summary');

      held.release(); await room.ready;
      owner.send({ type: 'start' });
      const live = [owner, late, back];
      await until(() => live.every(p => p.has('ready')), 'ready for every player');
      const ids = new Set();
      for (const p of live) {
        const own = p.session.playerId ?? p.welcome().id;
        const ready = p.messages.find(m => m.type === 'ready');
        assert.ok(ready.state.players.some(x => x.id === own), 'in their own view');
        ids.add(own);
      }
      assert.equal(ids.size, 3, 'three distinct seats');
      for (const p of live) {
        await until(() => p.frames.some(f => f.phase === 'live'), 'live state frames');
        const own = p.session.playerId ?? p.welcome().id;
        assert.ok(p.frames.findLast(f => f.phase === 'live').players.some(x => x.id === own), 'a player is in its own live view');
      }

      owner.send({ type: 'finish' });
      await until(() => owner.has('saved'), 'saved message');
      await until(() => h.replays.list().some(r => r.id === room.id), 'the archive listed');
      await until(() => !inRoom(h.service, room.id), 'the room leaving the directory');
      assert.deepEqual(h.errors, []);
    } finally { await h.finish(); }
  });

  test(`a resume takes over a seat and closes the old session (${label})`, async () => {
    const h = await host(threads);
    try {
      const room = h.service.makeRoom(9, false, undefined, generatedMap(9));
      await room.ready;
      const owner = h.join(room, { ownerKey: room.ownerKey });
      const other = h.join(room, { role: 'gladiator', name: 'Other' });
      await until(() => owner.has('welcome') && other.has('welcome'), 'welcomes');
      owner.send({ type: 'start' });
      await until(() => other.has('ready'), 'the match starting');
      const takeover = h.join(room, { resumeKey: other.welcome().resumeKey });
      await until(() => takeover.has('welcome') && other.closes.length, 'the takeover');
      assert.equal(other.closes[0][1], CLOSE_REASON.SESSION_RESUMED);
      assert.equal(takeover.welcome().id, other.welcome().id);
      await until(() => takeover.frames.length, 'state frames for the new session');
      assert.equal(owner.closes.length, 0);
      assert.deepEqual(h.errors, []);
    } finally { await h.finish(); }
  });

  test(`a failed map is reported, tells the players and frees the place (${label})`, async () => {
    const h = await host(threads);
    try {
      const held = heldMap(), room = h.service.makeRoom(9, false, undefined, held.promise);
      const player = h.join(room, { name: 'Waiting' });
      await until(() => player.has('welcome'), 'welcome');
      held.fail(new Error('generation broke'));
      await room.ready;
      await until(() => player.messages.some(m => m.type === 'error' && /could not be generated/.test(m.message)), 'the error message');
      await until(() => !inRoom(h.service, room.id), 'the room leaving the directory');
      assert.deepEqual(h.errors.map(e => e.message), ['generation broke']);
    } finally { await h.finish(); }
  });

  test(`closing while a map is pending settles quietly, and a live room's archive is finalized (${label})`, async () => {
    const h = await host(threads);
    try {
      const held = heldMap(), pending = h.service.makeRoom(9, false, undefined, held.promise);
      const liveRoom = h.service.makeRoom(9, false, undefined, generatedMap(9));
      await liveRoom.ready;
      const owner = h.join(liveRoom, { ownerKey: liveRoom.ownerKey });
      await until(() => owner.has('welcome'), 'welcome');
      owner.send({ type: 'start' });
      await until(() => owner.frames.some(f => f.phase === 'live'), 'the match live');
      await h.service.close();
      // A room run here settles `ready` only when its map does (a threaded one at once): release it before waiting.
      held.release(); await pending.ready;
      assert.deepEqual(h.errors, []);
      const files = await readdir(h.dir);
      assert.ok(files.includes(`${liveRoom.id}.meta.json`), `archive finalized: ${files.join(', ')}`);
      assert.ok(files.includes(`${liveRoom.id}.json.gz`));
    } finally { await h.finish(); }
  });
}

test('both hosts record the same frames for the same map and seed', async () => {
  const runs = {};
  for (const threads of [false, true]) {
    const h = await host(threads);
    try {
      const room = h.service.makeRoom(9, false, undefined, generatedMap(9));
      await room.ready;
      const dev = h.join(room, { mode: 'dev', ownerKey: room.ownerKey });
      const owner = h.join(room, { ownerKey: room.ownerKey, name: 'Owner' });
      await until(() => dev.has('welcome') && owner.has('welcome'), 'welcomes');
      owner.send({ type: 'start' });
      await until(() => dev.frames.some(f => f.phase === 'live' && f.tick >= 40), 'tick 40');
      owner.send({ type: 'finish' });
      await until(() => owner.has('saved'), 'saved message');
      const archive = readArchive(await readFile(path.join(h.dir, `${room.id}.json.gz`)));
      const recorded = new Map(archive.frames.map(f => [f.state.tick, f.state]));
      const seen = new Map(dev.frames.filter(f => f.phase !== 'waiting').map(f => [f.tick, f]));
      // Player ids are random per join; the owner's stands for itself in both runs.
      const own = owner.welcome().id, plain = value => {
        // The physics world lists bodies, with their generations, in an order that follows the random ids; what the players are is the claim.
        const { physics, bodies, ...rest } = JSON.parse(JSON.stringify(value).replaceAll(own, 'OWNER'));
        return rest;
      };
      runs[threads] = { recorded: new Map([...recorded].map(([k, v]) => [k, plain(v)])), seen: new Map([...seen].map(([k, v]) => [k, plain(v)])) };
      assert.deepEqual(h.errors, []);
    } finally { await h.finish(); }
  }
  const [a, b] = [runs.false, runs.true];
  const shared = [...a.recorded.keys()].filter(tick => b.recorded.has(tick));
  assert.ok(shared.some(tick => tick >= 40), 'the archives overlap past tick 40');
  for (const tick of shared) assert.deepEqual(b.recorded.get(tick), a.recorded.get(tick), `archived tick ${tick}`);
  const seenBoth = [...a.seen.keys()].filter(tick => b.seen.has(tick));
  assert.ok(seenBoth.length > 0, 'the dev watchers share a tick');
  for (const tick of seenBoth) assert.deepEqual(b.seen.get(tick), a.seen.get(tick), `dev frame at tick ${tick}`);
});

test('a room thread that dies unasked tells its players and leaves the directory (threads)', async () => {
  const h = await host(true);
  try {
    const room = h.service.makeRoom(9, false, undefined, generatedMap(9));
    await room.ready;
    const owner = h.join(room, { ownerKey: room.ownerKey });
    await until(() => owner.has('welcome'), 'welcome');
    await h.service.rooms.get(room.id).worker.terminate();
    await until(() => owner.messages.some(m => m.type === 'error'), 'the error message');
    await until(() => !inRoom(h.service, room.id), 'the room leaving the directory');
    await until(() => h.errors.length > 0, 'the error reported');
  } finally { await h.finish(); }
});
