import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';

for (const failure of ['start', 'append', 'async']) test(`${failure} recording failure leaves inputs, viewers and other rooms live`, async () => {
  const errors = []; let fail, appends = 0, aborts = 0;
  const h = roomHarness({ reportError: e => errors.push(e.message), startWriter(header, { onError }) {
    if (header.seed === 9 && failure === 'start') throw new Error('start failed');
    if (header.seed === 9) fail = onError;
    return { blocked: true, append() {
      if (header.seed === 9) { appends++; if (failure === 'append') throw new Error('append failed'); }
      return true;
    }, abort() { aborts++; }, async finish() { return { id: header.id }; } };
  } });
  try {
    const { room, owner } = h.live(9), other = h.live(4217);
    if (failure === 'async') { fail(new Error('async failed')); fail(new Error('duplicate failure')); }
    const player = room.game.players.find(p => p.id === owner.session.playerId);
    const x = player.x;
    owner.send({ type: 'input', seq: 1, x: 1 }); h.wake(50);
    assert.equal(room.match.tick, 1); assert.equal(other.room.match.tick, 1);
    assert.ok(player.x > x, 'player input continues after recording failure');
    assert.equal(room.inputs.length, 0, 'discard recording commands after failure');
    assert.equal(owner.messages.filter(m => m.type === 'replay-status').length, 1);
    assert.equal(owner.messages.some(m => m.type === 'error'), false);
    assert.equal(owner.messages.filter(m => m.type === 'state').at(-1).state.tick, 1);
    const guest = h.joined(room), spectator = h.joined(room, { role: 'spectator', ownerKey: room.ownerKey });
    for (const viewer of [guest, spectator]) assert.equal(viewer.messages.find(m => m.type === 'replay-status').status, 'failed');
    for (let i = 0; i < 20; i++) { owner.send({ type: 'input', seq: i + 2 }); h.wake(50); }
    assert.ok(appends <= 1, 'do not keep calling a failed writer'); assert.equal(room.inputs.length, 0);
    await h.service.close();
    assert.equal(owner.messages.some(m => m.type === 'saved'), false);
    assert.equal(other.owner.messages.filter(m => m.type === 'saved').length, 1);
    assert.equal(errors.length, 1); assert.equal(aborts, failure === 'start' ? 0 : 1);
  } finally { await h.service.close(); }
});

test('partial recording transitions notify once and successful recovery retains partial metadata', async () => {
  let omit = false, droppedFrames = 0;
  const h = roomHarness({ startWriter(header) { return {
    get droppedFrames() { return droppedFrames; },
    append() { if (omit) { droppedFrames++; return false; } return true; },
    async finish({ ticks }) { return { id: header.id, recording: { complete: false, droppedFrames, endTick: ticks } }; }
  }; } });
  try {
    const { room, owner } = h.live();
    omit = true; h.wake(50); h.wake(50);
    omit = false; h.wake(50);
    assert.equal(room.match.tick, 3); assert.equal(room.debt, 0);
    assert.deepEqual(owner.messages.filter(m => m.type === 'replay-status').map(m => m.status), ['partial']);
    const guest = h.joined(room); assert.equal(guest.messages.find(m => m.type === 'replay-status').status, 'partial');
    owner.send({ type: 'finish' }); await h.service.close();
    const saved = owner.messages.find(m => m.type === 'saved');
    assert.deepEqual(saved.replay.recording, { complete: false, droppedFrames: 2, endTick: 3 });
  } finally { await h.service.close(); }
});

test('stalled adapter finalization has a deadline and cannot report late success', async () => {
  const deadlines = new Map(), errors = []; let serial = 0, release, aborted = 0;
  const pending = new Promise(resolve => release = resolve);
  const h = roomHarness({ reportError: e => errors.push(e.message),
    setTimer(fn) { deadlines.set(++serial, fn); return serial; }, clearTimer(id) { deadlines.delete(id); },
    startWriter() { return { append() {}, finish: () => pending, abort() { aborted++; } }; }
  });
  const { room, owner } = h.live(), second = h.live(4217);
  const closing = h.service.close();
  assert.equal(h.service.close(), closing);
  assert.equal(deadlines.size, 2, 'finalization starts concurrently for every room');
  for (const fn of [...deadlines.values()]) fn();
  await closing;
  assert.equal(room.finished, true); assert.equal(second.room.finished, true);
  assert.equal(aborted, 2); assert.equal(errors.length, 2); assert.equal(deadlines.size, 0);
  release({ id: room.id }); await Promise.resolve(); await Promise.resolve();
  for (const peer of [owner, second.owner]) {
    assert.equal(peer.messages.filter(m => m.type === 'saved').length, 0);
    assert.equal(peer.messages.filter(m => m.type === 'replay-status').length, 1);
  }
});

test('synchronous callback failure during start and failed cleanup are contained', async () => {
  const errors = [];
  const h = roomHarness({ reportError: e => errors.push(e.message), startWriter(_header, { onError }) {
    onError(new Error('early failure'));
    return { abort() { throw new Error('cleanup failed'); }, append() { assert.fail('failed writer must not append'); },
      finish() { throw new Error('finish failed'); } };
  } });
  const { room, owner } = h.live(); h.wake(50); await h.service.close();
  assert.equal(room.match.tick, 1); assert.deepEqual(errors, ['early failure']);
  assert.equal(owner.messages.filter(m => m.type === 'replay-status').length, 1);
});
