import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { SPECTATOR_DELAY_TICKS } from '../server/room-views.js';
import { TICK_MS } from '../server/scheduler.js';
import { CLOSE_CODE, CLOSE_REASON } from '../server/protocol.js';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';

function memoryReplays() {
  const started = [], finished = [], discarded = [];
  return {
    started,
    finished,
    discarded,
    start(header) {
      const frames = [];
      started.push({ header: structuredClone(header), frames });
      return {
        append(state, commands) { frames.push(structuredClone({ state, commands })); return true; },
        finish(summary) { finished.push(structuredClone(summary)); return { ok: true }; },
        discard() { discarded.push(header.id); return frames.length === 0; },
      };
    },
  };
}

function makeRoomHarness(options = {}) {
  const delivered = new Map();
  const closed = [];
  const disposed = [];
  const droppedFor = new Set();
  const replays = options.replays ?? memoryReplays();
  let now = options.now ?? 1000;

  const room = createRoom({
    replays,
    devTools: options.devTools ?? 'all',
    wallNow: () => now,
    deliver(clientId, payload, droppable) {
      if (typeof payload !== 'string') throw new Error(`Expected serialized payload, got ${typeof payload}`);
      if (droppable && droppedFor.has(clientId)) return false;
      let list = delivered.get(clientId);
      if (!list) delivered.set(clientId, list = []);
      list.push({ payload, message: JSON.parse(payload), droppable: !!droppable });
      return true;
    },
    closeClient(clientId, code, reason) {
      closed.push({ clientId, code, reason });
    },
    onDispose(id, clientIds) {
      disposed.push({ id, clientIds });
    },
    ...options.roomOptions,
  });

  const messages = clientId => (delivered.get(clientId) ?? []).map(entry => entry.message);
  const lastOfType = (clientId, type) => messages(clientId).findLast(message => message.type === type);

  return {
    room,
    replays,
    delivered,
    closed,
    disposed,
    droppedFor,
    messages,
    lastOfType,
    advanceClock(ms) { now += ms; },
  };
}

test('Room lifecycle covers deferred map adoption, waiting yard isolation, and waiting-to-match handoff', async () => {
  const h = makeRoomHarness();
  const { room, replays } = h;
  const descriptor = room.onCreate({
    id: 'room-1',
    ownerKey: 'owner-1',
    seed: 9,
    deferredMap: true,
    content: defaultContent(),
    name: 'Lifecycle Check',
  });

  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'name', 'ownerKey', 'ready', 'seed', 'size']);
  assert.equal(descriptor.id, 'room-1');
  assert.equal(descriptor.ownerKey, 'owner-1');
  assert.equal(descriptor.name, 'Lifecycle Check');
  assert.equal(room.summary().phase, 'lobby');
  assert.equal(room.summary().ready, false);
  assert.deepEqual(room.metrics(), { live: false, emptyLive: false });

  const joined = room.onJoin('c1', { ownerKey: 'owner-1', role: 'contestant', name: 'Alice' });
  assert.equal(joined.ok, true);
  assert.equal(joined.owner, true);

  const welcome = h.lastOfType('c1', 'welcome');
  assert.equal(welcome.ready, false);
  assert.equal(welcome.started, false);
  assert.ok(welcome.map && Array.isArray(welcome.map.spawns), 'initial welcome uses waiting yard map');

  await room.waiting.ready;
  const startWaitingX = room.waiting.players[0].x;
  room.onMessage('c1', { type: 'input', seq: 1, x: 1, y: 0 });
  assert.equal(room.inputs.some(entry => entry.type === 'input'), false, 'waiting-yard movement is never recorded as match input');

  // Early start request queues until adoptMap resolves.
  room.onMessage('c1', { type: 'start' });
  assert.equal(room.started, false);

  // Step the waiting yard and verify state is broadcast without advancing any match.
  room.tick(TICK_MS * 2, 2000);
  assert.ok(room.waiting.players[0].x > startWaitingX, 'waiting simulation advances before match start');
  assert.ok(h.lastOfType('c1', 'state')?.state?.tick >= 1, 'waiting frames reach seated clients');

  room.adoptMap(generatedMap());
  await descriptor.ready;

  assert.equal(room.started, true, 'queued start transitions automatically once adoptMap completes');
  assert.equal(room.waiting, null, 'waiting simulation is disposed on match handoff');
  assert.equal(room.summary().phase, 'live');
  assert.equal(room.summary().ready, true);
  assert.deepEqual(room.metrics(), { live: true, emptyLive: false });
  assert.equal(replays.started.length, 1, 'one recording, opened when the match was prepared');
  assert.equal(replays.started[0].frames[0].commands.at(-1).type, 'start', 'its first frame is the start');
  assert.ok(h.lastOfType('c1', 'ready')?.map?.width > 0, 'ready payload notifies client of live match handoff');

  await room.close();
  assert.equal(replays.finished.length, 1);
});

test('Room lifecycle rejects join after failMap and forwards room-local validation replies', async () => {
  const h = makeRoomHarness({ roomOptions: { reportError() {} } });
  const { room } = h;
  const descriptor = room.onCreate({ id: 'room-fail', ownerKey: 'owner-f', deferredMap: true, content: defaultContent() });
  const join = room.onJoin('c1', { ownerKey: 'owner-f', role: 'contestant', name: 'Bob' });
  assert.equal(join.ok, true);

  room.onInvalidMessage('c1', { type: 'choose', reason: 'Invalid kit selection' });
  assert.equal(h.lastOfType('c1', 'choose')?.ok, false);
  assert.match(h.lastOfType('c1', 'choose')?.message ?? '', /Invalid kit/);

  room.failMap(new Error('worker exited'));
  await descriptor.ready;
  assert.equal(room.summary(), null, 'failed map tears down unstarted room');

  const lateJoin = room.onJoin('c2', { role: 'contestant', name: 'Late' });
  assert.equal(lateJoin.ok, false);
  assert.equal(h.lastOfType('c2', 'error')?.message, 'This arena has ended or no longer exists. Start a new match.');
  assert.equal(h.disposed.length, 1);
  assert.deepEqual(h.disposed[0].clientIds, ['c1']);
});

test('Room resumes handle both disconnected reconnects and live-socket takeovers while rotating resume keys', async () => {
  const h = makeRoomHarness();
  const { room } = h;
  const descriptor = room.onCreate({
    id: 'room-resume',
    ownerKey: 'owner-r',
    map: generatedMap(),
    content: defaultContent(),
  });
  await descriptor.ready;

  const first = room.onJoin('c1', { ownerKey: 'owner-r', role: 'contestant', name: 'Runner' });
  const firstKey = h.lastOfType('c1', 'welcome').resumeKey;
  assert.ok(firstKey);
  await room.waiting.ready;
  room.onMessage('c1', { type: 'input', seq: 1, x: 0, y: 1 });
  room.tick(TICK_MS * 2, 1100);
  const waitingPos = { x: room.waiting.players[0].x, y: room.waiting.players[0].y };

  // Live takeover while c1 is still attached: closes old socket synchronously and rotates key.
  const takeover = room.onJoin('c2', { ownerKey: 'owner-r', resumeKey: firstKey });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.playerId, first.playerId);
  assert.equal(takeover.replacedClientId, 'c1');
  assert.deepEqual(h.closed, [{ clientId: 'c1', code: CLOSE_CODE.NORMAL, reason: CLOSE_REASON.SESSION_RESUMED }]);
  assert.equal(room.waiting.players[0].x, waitingPos.x, 'takeover preserves waiting position');
  assert.equal(room.waiting.players[0].y, waitingPos.y);
  assert.equal(room.resumes.has(firstKey), false, 'previous resumeKey is invalidated on takeover');

  // Reusing the rotated-out key opens a new seat instead of hijacking the resumed player.
  const stale = room.onJoin('c3', { resumeKey: firstKey, name: 'Other' });
  assert.equal(stale.ok, true);
  assert.notEqual(stale.playerId, first.playerId);

  // Disconnected resume before start restores the lobby seat; after start it reclaims the bot seat.
  const secondKey = h.lastOfType('c2', 'welcome').resumeKey;
  assert.equal(room.onLeave('c2'), true);
  assert.equal(room.seats.roster().some(p => p.id === first.playerId), false, 'leaving lobby removes player from active roster while keeping resumeKey');
  const rejoinedLobby = room.onJoin('c4', { ownerKey: 'owner-r', resumeKey: secondKey });
  assert.equal(rejoinedLobby.ok, true);
  assert.equal(rejoinedLobby.playerId, first.playerId);

  room.onMessage('c4', { type: 'start' });
  assert.equal(room.started, true);
  const thirdKey = h.lastOfType('c4', 'welcome').resumeKey;
  assert.equal(room.onLeave('c4'), true);
  assert.equal(room.seats.roster().some(p => p.id === first.playerId), false, 'leaving live match turns player seat back to bot');
  const rejoinedMatch = room.onJoin('c5', { ownerKey: 'owner-r', resumeKey: thirdKey });
  assert.equal(rejoinedMatch.ok, true);
  assert.equal(rejoinedMatch.playerId, first.playerId);
  assert.equal(room.seats.roster().some(p => p.id === first.playerId), true);

  await room.close();
});

test('Room projects delayed historical state to spectators and resends keyframes on dropped delivery', async () => {
  const h = makeRoomHarness();
  const { room, replays } = h;
  const descriptor = room.onCreate({
    id: 'room-view',
    ownerKey: 'owner-v',
    map: generatedMap(),
    content: defaultContent(),
  });
  await descriptor.ready;

  // Non-owner spectator is refused; owner spectator + dev watcher hold no seat and start no replay.
  assert.equal(room.onJoin('spec-denied', { mode: 'spectator' }).ok, false);
  const specJoin = room.onJoin('spec-1', { ownerKey: 'owner-v', mode: 'spectator' });
  const devJoin = room.onJoin('dev-1', { ownerKey: 'owner-v', mode: 'dev' });
  const playerJoin = room.onJoin('p1', { ownerKey: 'owner-v', role: 'contestant', name: 'Hero' });
  assert.equal(specJoin.ok, true);
  assert.equal(devJoin.ok, true);
  assert.equal(playerJoin.ok, true);
  assert.equal(room.spectators, 2);
  // The recording opens with the prepared match (#1088), but nothing is recorded before the start.
  assert.equal(replays.started.length, 1);
  assert.equal(replays.started[0].header.id, 'room-view');
  assert.ok(replays.started[0].header.map?.width > 0);
  assert.equal(replays.started[0].frames.length, 0);

  room.onMessage('p1', { type: 'start' });
  assert.equal(room.started, true);
  assert.equal(replays.started.length, 1);
  assert.equal(replays.started[0].frames.length, 1);

  // Drop the first live tick for p1 so keyframe acknowledgement stays unrecorded until the second tick succeeds.
  h.droppedFor.add('p1');
  room.tick(TICK_MS, 2000 + TICK_MS);
  assert.equal(h.messages('p1').filter(m => m.type === 'state' && m.state.phase === 'playing').length, 0, 'droppable tick 1 skipped for p1');
  h.droppedFor.delete('p1');

  room.tick(TICK_MS, 2000 + TICK_MS * 2);
  const firstDeliveredLive = h.lastOfType('p1', 'state')?.state;
  assert.equal(Array.isArray(firstDeliveredLive?.bodies?.all), true, 'resends full keyframe after initial delivery was dropped');

  // Next acknowledged tick sends delta rather than resending keyframe array `all`.
  room.tick(TICK_MS, 2000 + TICK_MS * 3);
  const ackedLive = h.lastOfType('p1', 'state')?.state;
  assert.equal(Array.isArray(ackedLive?.bodies?.all), false, 'acknowledged session receives delta layer after holding keyframe');

  // Advance beyond the spectator delay window so live dev tick and spectator tick diverge cleanly.
  const ticksToAdvance = SPECTATOR_DELAY_TICKS + 10;
  for (let i = 4; i <= ticksToAdvance; i++) {
    room.tick(TICK_MS, 2000 + i * TICK_MS);
  }

  const devState = h.lastOfType('dev-1', 'state').state;
  const specState = h.lastOfType('spec-1', 'state').state;
  assert.equal(devState.tick, room.match.tick);
  assert.equal(specState.tick, room.match.tick - SPECTATOR_DELAY_TICKS, 'spectator view lags behind live dev view by SPECTATOR_DELAY_TICKS');

  // Reconnecting with a fresh connection starts with empty held layerKeys, so full keyframe (`all`) is delivered again.
  const resumeKey = h.lastOfType('p1', 'welcome').resumeKey;
  room.onJoin('p1-next', { ownerKey: 'owner-v', resumeKey });
  room.tick(TICK_MS, 2000 + (ticksToAdvance + 1) * TICK_MS);
  const resumedState = h.lastOfType('p1-next', 'state').state;
  assert.equal(Array.isArray(resumedState.bodies?.all), true, 'fresh session after resume receives full keyframe arrays');

  // Calling onLeave on spectator decrements watcher counter cleanly and onDispose notifies host callback.
  assert.equal(room.onLeave('spec-1'), true);
  assert.equal(room.spectators, 1);
  room.onDispose();
  assert.equal(h.disposed.length, 1);
  assert.ok(h.disposed[0].clientIds.includes('p1-next'));

  await room.close();
});

test('A room that closes or retires before its start discards the recording it opened (#1088)', async () => {
  for (const end of ['close', 'retire']) {
    const h = makeRoomHarness();
    const descriptor = h.room.onCreate({ id: `unstarted-${end}`, ownerKey: 'k', map: generatedMap(), content: defaultContent() });
    await descriptor.ready;
    assert.equal(h.replays.started.length, 1);
    if (end === 'close') await h.room.close();
    else { h.advanceClock(181000); h.room.tick(TICK_MS, 0); }
    assert.deepEqual(h.replays.discarded, [`unstarted-${end}`], end);
    assert.equal(h.replays.finished.length, 0);
  }
});
