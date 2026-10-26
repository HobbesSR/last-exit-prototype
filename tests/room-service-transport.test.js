import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { parseMessage, acceptMessageRate, roomSeed, roomSize, devToolsPolicy, deliverable, MAX_BUFFERED_BYTES, MAX_DIAGNOSTICS_PER_SESSION } from '../server/protocol.js';

test('a backed-up socket skips state frames but never a one-off message', () => {
  assert.equal(deliverable(MAX_BUFFERED_BYTES, true), false);
  assert.equal(deliverable(MAX_BUFFERED_BYTES - 1, true), true);
  assert.equal(deliverable(MAX_BUFFERED_BYTES * 4, false), true);
  const h = roomHarness({ reuseMaps: true }), { room } = h.live(), flags = [];
  const session = h.service.connect({ deliver: (payload, droppable) => flags.push([JSON.parse(payload).type, droppable]), close() {} });
  h.service.receive(session, { type: 'join', room: room.id }); h.wake(50);
  assert.deepEqual(flags.filter(([type]) => type !== 'ping'), [['welcome', undefined], ['lobby', undefined], ['state', true]]);
  return h.service.close();
});

test('the dev tools policy accepts only its named values', () => {
  assert.equal(devToolsPolicy(undefined), 'none'); assert.equal(devToolsPolicy(''), 'none');
  for (const value of ['none', 'owner', 'all']) assert.equal(devToolsPolicy(value), value);
  assert.throws(() => devToolsPolicy('yes'), /DEV_TOOLS must be one of none, owner, all/);
});

test('matchmaking deadlines and abandonment are testable without sockets or real waiting', async () => {
  const h = roomHarness({ reuseMaps: true }), player = h.peer(); player.send({ type: 'match', role: 'gladiator' });
  const room = player.session.room;
  h.wake(0, 14999); assert.equal(room.started, false);
  h.wake(0, 1); assert.equal(room.started, true);
  h.service.disconnect(player.session); h.wake(0);
  h.wake(0, 29999); assert.equal(room.finished, false);
  h.wake(0, 1); assert.equal(room.finished, true);
  const last = h.writers.get(room.id).frames.at(-1);
  assert.ok(last.commands.some(c => c.type === 'abandoned')); assert.equal(last.state.phase, 'finished');
  await h.service.close();
});

test('transport decoding, message budget and seed coercion retain existing acceptance rules', () => {
  assert.equal(parseMessage('null'), null); assert.equal(parseMessage('5'), null);
  assert.throws(() => parseMessage('{'), SyntaxError);
  assert.deepEqual(parseMessage(Buffer.from('{"type":"start"}')), { type: 'start' });
  const budget = { start: 100, messages: 0 };
  for (let i = 0; i < 70; i++) assert.equal(acceptMessageRate(budget, 100), true);
  assert.equal(acceptMessageRate(budget, 1100), false); assert.equal(acceptMessageRate(budget, 1101), true);
  assert.equal(roomSeed({ seed: '9' }), 9); assert.equal(roomSeed({}), undefined, 'none named: the directory chooses');
  for (const seed of [0, -1, 2147483648, 1.5, 'bad']) assert.equal(roomSeed({ seed }), null);
  assert.deepEqual(roomSize({}), { zoneWidth: 12, zoneHeight: 6 });
  assert.deepEqual(roomSize({ size: '36x18' }), { zoneWidth: 36, zoneHeight: 18 });
  for (const size of ['13x6', '12 x 6', 12, null, '']) assert.equal(roomSize({ size }), null, String(size));
});

test('a catch-up past the cap leaves a server-stall marker on the recording, and normal wakes leave none', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { writer } = h.live();
    h.wake(50); h.wake(50);
    assert.deepEqual(writer.marks, []);
    h.wake(50 * 9);
    assert.equal(writer.marks.length, 1);
    const [mark] = writer.marks;
    assert.equal(mark.kind, 'server-stall');
    assert.equal(mark.wakeMs, 450); assert.equal(mark.owed, 9); assert.equal(mark.simulated, 5);
    assert.equal(mark.tick, writer.frames.at(-1).state.tick, 'marked at the last tick the stall simulated');
    assert.ok(writer.frames.every(frame => frame.commands.every(c => c.kind !== 'server-stall')), 'never a recorded command');
  } finally { await h.service.close(); }
});

test('a stall marker counts the ticks actually simulated when the match ends mid catch-up', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { room, writer } = h.live();
    h.wake(50);
    room.game.tick = room.game.content.durationTicks - 1;
    const before = writer.frames.length;
    h.wake(50 * 9);
    const added = writer.frames.length - before, [mark] = writer.marks;
    assert.ok(added >= 1 && added < 5, 'the batch ended early');
    assert.equal(mark.owed, 9);
    assert.equal(mark.simulated, added, 'simulated is the steps taken, not the budget');
    assert.equal(mark.tick, writer.frames.at(-1).state.tick);
  } finally { await h.service.close(); }
});

test('client diagnostics become recorded marks, never commands, and are validated and limited', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { room, owner, writer } = h.live();
    for (let i = 0; i < 12; i++) h.wake(50, 300);
    const tick = writer.frames.at(-1).state.tick, pending = room.inputs.length;
    owner.send({ type: 'diagnostic', kind: 'frame-drop', tick: tick - 3, startTick: tick - 9, count: 7.4, worstMs: 120.6 });
    assert.equal(writer.marks.length, 1);
    const [mark] = writer.marks;
    assert.equal(mark.kind, 'frame-drop'); assert.equal(mark.tick, tick - 3); assert.equal(mark.startTick, tick - 9);
    assert.equal(mark.count, 7); assert.equal(mark.worstMs, 121); assert.equal(mark.playerId, owner.session.playerId);
    assert.equal(mark.arrivalTick, tick);
    // The frame already written cannot show a command queued for the next tick, so look where it would wait.
    assert.equal(room.inputs.length, pending, 'not queued among the inputs the next tick records');
    const written = writer.frames.length;
    h.wake(50, 0); // a tick, with no wall time for the rate limit below
    assert.ok(writer.frames.length > written, 'a tick was recorded after the report');
    assert.ok(writer.frames.slice(written).every(frame => frame.commands.every(c => c.type !== 'diagnostic' && c.kind !== 'frame-drop')),
      'and the frame it wrote carries no trace of the report');
    owner.send({ type: 'diagnostic', kind: 'manual', tick });
    assert.equal(writer.marks.length, 1, 'rate limited');
    h.wake(50, 300);
    owner.send({ type: 'diagnostic', kind: 'bogus', tick }); owner.send({ type: 'diagnostic', kind: 'manual', tick: 'x' });
    assert.equal(writer.marks.length, 1, 'unknown kind and non-numeric tick are ignored');
    owner.send({ type: 'diagnostic', kind: 'manual', tick: 1e12, startTick: -5 });
    assert.equal(writer.marks.length, 2);
    assert.ok(writer.marks[1].tick <= writer.marks[1].arrivalTick, 'a future tick is clamped to arrival');
  } finally { await h.service.close(); }
});

test('diagnostic reports are capped per session', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { owner, writer } = h.live();
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_SESSION + 5; i++) { h.wake(50, 300); owner.send({ type: 'diagnostic', kind: 'manual', tick: 0 }); }
    assert.equal(writer.marks.length, MAX_DIAGNOSTICS_PER_SESSION);
  } finally { await h.service.close(); }
});

test('an admitted spectator has no diagnostic authority, independent of any cap or rate limit', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { room, writer } = h.live();
    // Refused admission is a different boundary: that session never reaches the room at all.
    const outsider = h.joined(room, { role: 'spectator' });
    assert.match(outsider.messages[0].message, /owner key/); assert.equal(outsider.session.room, undefined);
    const eye = h.joined(room, { role: 'spectator', ownerKey: room.ownerKey });
    const welcome = eye.messages.find(m => m.type === 'welcome');
    assert.equal(welcome.spectator, true, 'admitted'); assert.equal(eye.session.room, room); assert.equal(eye.session.playerId, null);
    // A fresh session with time since the last report: only its role can refuse it.
    h.wake(50, 300);
    const pending = room.inputs.length, written = writer.frames.length;
    eye.send({ type: 'diagnostic', kind: 'manual', tick: 0 });
    assert.deepEqual(writer.marks, [], 'no recorded mark');
    assert.equal(room.inputs.length, pending, 'nor a queued command');
    h.wake(50, 300);
    assert.ok(writer.frames.slice(written).every(frame => frame.commands.every(c => c.type !== 'diagnostic' && c.kind !== 'manual')));
  } finally { await h.service.close(); }
});

test('a room created at a larger size starts, advertises it and records that map', () => {
  const generateMap = (seed, size) => ({ ...generatedMap(seed), width: size.zoneWidth * 1440, height: size.zoneHeight * 1440 });
  const h = roomHarness({ reuseMaps: true, generateMap }), size = { zoneWidth: 24, zoneHeight: 12 };
  const room = h.service.makeRoom(9, false, size, generateMap(9, size)), owner = h.joined(room, { ownerKey: room.ownerKey });
  assert.equal(owner.messages.find(m => m.type === 'lobby').size, '24x12');
  owner.send({ type: 'start' });
  const { header } = h.writers.get(room.id);
  assert.deepEqual([header.map.width, header.map.height], [34560, 17280]);
  assert.equal(room.game.map.width, 34560);
});
