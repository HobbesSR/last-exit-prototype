import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { createMatch } from '../server/match.js';
import { createGame, joinGame, setInput, step, snapshot } from '../shared/simulation.ts';
import { parseMessage, acceptMessageRate, roomSeed, roomSize, devToolsPolicy, deliverable, MAX_BUFFERED_BYTES, MAX_DIAGNOSTICS_PER_SESSION } from '../server/protocol.js';

test('three hunter places are advertised, admitted, reclaimed and recorded', async () => {
  const h = roomHarness(), room = h.service.makeRoom(9);
  try {
    const owner = h.joined(room, { ownerKey: room.ownerKey });
    const hunters = ['warden', 'specter', 'striker'].map(kit => h.joined(room, { role: 'gladiator', kit }));
    const lobby = owner.messages.filter(m => m.type === 'lobby').at(-1);
    assert.deepEqual(lobby.capacity, { contestant: 8, gladiator: 3 });
    assert.equal(lobby.players.filter(p => p.role === 'gladiator').length, 3);
    assert.ok(hunters.every(p => p.session.playerId));
    const fourth = h.joined(room, { role: 'gladiator' });
    assert.match(fourth.messages[0].message, /No gladiator places/);
    assert.equal(fourth.session.playerId, null);
    const third = hunters[2], welcome = third.messages.find(m => m.type === 'welcome');
    h.service.disconnect(third.session);
    const resumed = h.joined(room, { resumeKey: welcome.resumeKey });
    assert.equal(resumed.session.playerId, welcome.id);
    assert.equal(room.match.player(welcome.id).kit, 'striker');
    owner.send({ type: 'start' });
    const writer = h.writers.get(room.id);
    assert.equal(writer.header.contentId, 'content-2');
    assert.equal(writer.header.version, 'last-exit-0.7');
    assert.equal(writer.header.schema, 5);
    assert.equal(writer.header.minSchema, 4);
    assert.equal(writer.frames[0].state.players.filter(p => p.role === 'gladiator').length, 3);
    assert.equal(writer.frames[0].state.slots, 3);
  } finally { await h.service.close(); }
});

test('matchmaking balances occupied fractions against three hunter places and fills all eleven slots', async () => {
  const h = roomHarness();
  try {
    const match = role => { const p = h.peer(); p.send({ type: 'match', role }); return p; };
    const first = match('gladiator'), room = first.session.room;
    // 3/8 contestants is above 1/3 hunters, but below the obsolete 1/2 fraction.
    for (let i = 0; i < 3; i++) match('contestant');
    const balanced = match('any');
    assert.equal(room.match.player(balanced.session.playerId).role, 'gladiator');
    const third = match('gladiator');
    assert.equal(room.match.player(third.session.playerId).role, 'gladiator');
    const fallback = match('gladiator');
    assert.equal(room.match.player(fallback.session.playerId).role, 'contestant');
    for (let i = 0; i < 4; i++) assert.equal(match('any').session.room, room);
    assert.equal(room.match.roster().length, 11);
    assert.notEqual(match('any').session.room, room, 'a full room cannot admit a twelfth player');
  } finally { await h.service.close(); }
});

test('match boundary preserves simulation output and returns detached commands, identities and maps', () => {
  const match = createMatch(9), game = createGame(9, match.map());
  const actor = match.join('human', 'contestant', 'warden', 'Runner');
  joinGame(game, 'human', 'contestant', 'warden', 'Runner'); actor.name = 'Changed';
  const command = { seq: 1, x: 1, interact: true, hp: 999 };
  const accepted = match.acceptInput('human', command); setInput(game, 'human', command);
  for (let i = 0; i < 15; i++) { step(game); assert.deepEqual(match.advance(), snapshot(game)); }
  assert.equal(accepted.input.interact, true); assert.equal(accepted.input.hp, undefined);
  assert.equal(match.acceptInput('human', command), null);
  const map = match.map(); map.items.length = 0;
  const frame = match.snapshot(); frame.players[0].hp = 0;
  assert.ok(match.map().items.length); assert.equal(match.snapshot().players[0].hp, 100);
  assert.equal(match.player('human').name, 'Runner');
});

test('fake clock preserves debt, catch-up cap, every recorded tick and newest-only delivery', async () => {
  const h = roomHarness(), { owner, writer, room } = h.live(); owner.messages.length = 0;
  h.wake(25); assert.equal(room.match.tick, 0);
  h.wake(25); assert.equal(room.match.tick, 1);
  h.wake(450); assert.equal(room.match.tick, 6);
  assert.deepEqual(writer.frames.map(f => f.state.tick), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(owner.messages.filter(m => m.type === 'state').map(m => m.state.tick), [1, 6]);
  writer.blocked = true; h.wake(200); assert.equal(room.match.tick, 10, 'storage pressure cannot pause simulation');
  writer.blocked = false; h.wake(0); assert.equal(room.match.tick, 10);
  assert.equal(room.debt, 0); await h.service.close();
});

test('room command recording owns each sanitized input independently of later ticks', async () => {
  const h = roomHarness(), { owner, writer } = h.live();
  owner.send({ type: 'input', seq: 1, interact: true, moveSlot: { from: 0, to: 5 }, hp: 999 });
  owner.send({ type: 'input', seq: 2, x: 1 }); h.wake(50);
  const inputs = writer.frames.at(-1).commands.filter(c => c.type === 'input');
  // Both arrived before the tick and both are recorded on arrival, but each carries exactly what its
  // own client message carried. Nothing is merged forward into the next one any more.
  assert.equal(inputs.length, 2); assert.equal(inputs[0].input.interact, true);
  assert.deepEqual(inputs[0].input.moveSlot, { from: 0, to: 5 });
  assert.equal(inputs[1].input.moveSlot, undefined); assert.equal(inputs[1].input.interact, false);
  assert.equal(inputs[0].input.hp, undefined, 'fields a client may not set are dropped');
  // One tick spends one input, so only the first is acknowledged; the second waits for the next tick.
  assert.equal(writer.frames.at(-1).state.players.find(p => p.id === owner.session.playerId).lastSeq, 1);
  await h.service.close();
});

test('inventory gesture commands preserve source items in authoritative frames and recordings', async () => {
  const h = roomHarness(), { room, owner, writer } = h.live();
  try {
    const game = room.game, player = game.players.find(p => p.id === owner.session.playerId);
    for (const actor of game.players) { actor.bot = false; actor.input = {}; }
    game.map.items = []; game.map.traps = [];
    const weapon = { kind: 'weapon', weaponType: 'rifle', ammo: 7 };
    const cell = { kind: 'cell', charge: 71 };
    player.inventory = [cell, null, null, null, null, weapon]; player.selectedSlot = 0;

    owner.send({ type: 'input', seq: 1, moveSlot: { from: 5, to: 0 } }); h.wake(50);
    assert.deepEqual(player.inventory[0], weapon); assert.deepEqual(player.inventory[5], cell);
    assert.equal(player.selectedSlot, 5, 'selection follows the swapped cell');

    owner.send({ type: 'input', seq: 3, slot: 0, drop: true }); h.wake(50);
    assert.equal(player.inventory[0], null); assert.deepEqual(player.inventory[5], cell);
    const dropped = game.map.items.find(item => item.droppedBy === player.id);
    assert.equal(dropped.weaponType, 'rifle'); assert.equal(dropped.ammo, 7);
    const recorded = writer.frames.at(-1);
    assert.deepEqual(recorded.state.items.find(item => item.id === dropped.id), dropped);
    const command = recorded.commands.find(c => c.seq === 3);
    assert.equal(command.input.slot, 0); assert.equal(command.input.drop, true);
    assert.equal(command.input.moveSlot, undefined);
    const delivered = owner.messages.filter(m => m.type === 'state').at(-1).state;
    assert.deepEqual(delivered.players.find(p => p.id === player.id).inventory, player.inventory);

    h.wake(50);
    assert.equal(game.map.items.filter(item => item.droppedBy === player.id).length, 1, 'drop is consumed once');
    assert.deepEqual(player.inventory[5], cell);
  } finally { await h.service.close(); }
});

test('fake sessions retain owner checks, spectator delay and safe live-session replacement', async () => {
  const h = roomHarness(), { room, owner } = h.live();
  const denied = h.joined(room, { role: 'spectator' }); assert.match(denied.messages[0].message, /owner key/);
  const eye = h.joined(room, { role: 'spectator', ownerKey: room.ownerKey });
  assert.equal(eye.messages[0].state.tick, 0); assert.equal(eye.session.playerId, null);
  for (let i = 0; i < 70; i++) h.wake(50);
  assert.equal(eye.messages.at(-1).state.tick, 10); assert.equal(room.history.length, 62);
  const welcome = owner.messages.find(m => m.type === 'welcome');
  const resumed = h.joined(room, { ownerKey: room.ownerKey, resumeKey: welcome.resumeKey });
  assert.equal(resumed.session.playerId, owner.session.playerId); assert.equal(owner.session.room, null);
  assert.deepEqual(owner.closes, [[1000, 'Session resumed']]);
  assert.notEqual(resumed.messages[0].resumeKey, welcome.resumeKey);
  assert.ok(room.match.roster().some(p => p.id === resumed.session.playerId));
  await h.service.close();
});

test('the dev view follows the server policy and sees the current directed frame', async () => {
  const closed = roomHarness(), shut = closed.live();
  try {
    const refused = closed.joined(shut.room, { role: 'dev', ownerKey: shut.room.ownerKey });
    assert.match(refused.messages[0].message, /not enabled/);
    assert.equal(shut.owner.messages.find(m => m.type === 'welcome').devTools, false, 'players are told when the dev view is off');
  } finally { await closed.service.close(); }

  const owned = roomHarness({ devTools: 'owner' }), mine = owned.live();
  try {
    assert.match(owned.joined(mine.room, { role: 'dev' }).messages[0].message, /owner key/);
    assert.equal(owned.joined(mine.room, { role: 'dev', ownerKey: mine.room.ownerKey }).session.dev, true);
    assert.equal(owned.joined(mine.room, {}).messages.find(m => m.type === 'welcome').devTools, false, 'a joiner without the key is not offered it');
  } finally { await owned.service.close(); }

  const h = roomHarness({ devTools: 'all' }), { room, owner, writer } = h.live();
  try {
    assert.equal(owner.messages.find(m => m.type === 'welcome').devTools, true);
    const dev = h.joined(room, { role: 'dev' }), welcome = dev.messages[0];
    assert.equal(welcome.dev, true); assert.equal(welcome.id, null); assert.equal(welcome.state.directed, true);
    assert.equal(dev.session.playerId, null); assert.equal(room.match.roster().length, 1, 'the dev view holds no slot');
    const spectator = h.joined(room, { role: 'spectator', ownerKey: room.ownerKey });
    for (let i = 0; i < 70; i++) h.wake(50);
    const live = dev.messages.at(-1).state, delayed = spectator.messages.at(-1).state;
    assert.equal(live.tick, room.match.tick, 'the dev view is not delayed');
    assert.equal(live.directed, true); assert.ok(live.players.every(p => 'x' in p));
    assert.ok(room.match.tick - delayed.tick >= 55, 'the ordinary spectator delay is unchanged');
    dev.send({ type: 'input', seq: 1, x: 1 }); dev.send({ type: 'start' }); h.wake(50);
    assert.ok(!writer.frames.at(-1).commands.length, 'a dev view sends no commands');
    h.service.disconnect(dev.session); h.service.disconnect(spectator.session);
    assert.equal(room.spectators, 0);
  } finally { await h.service.close(); }
});

test('a dev pause stops only its own room, drops owed time and leaves one mark', async () => {
  const h = roomHarness({ devTools: 'all' }), { room, owner, writer } = h.live(), other = h.live(10);
  try {
    const dev = h.joined(room, { role: 'dev' });
    h.wake(100); const tick = room.match.tick;
    dev.send({ type: 'dev', action: 'pause' });
    assert.deepEqual(owner.messages.at(-1), { type: 'paused', paused: true, tick });
    const otherTick = other.room.match.tick;
    for (let i = 0; i < 40; i++) h.wake(50);
    assert.equal(room.match.tick, tick, 'a paused room runs no tick');
    assert.ok(other.room.match.tick > otherTick + 30, 'another room keeps running');
    owner.send({ type: 'input', seq: 1, x: 1 });
    assert.equal(h.joined(room, {}).messages.find(m => m.type === 'welcome').paused, true, 'a joiner learns the room is paused');
    dev.send({ type: 'dev', action: 'pause' }); dev.send({ type: 'dev', action: 'resume' });
    assert.deepEqual(writer.marks, [{ tick, kind: 'pause', pausedMs: 2000 }]);
    h.wake(100);
    assert.equal(room.match.tick, tick + 2, 'resuming does not catch up the paused time');
    assert.ok(!writer.marks.some(m => m.kind === 'server-stall'));
    dev.send({ type: 'dev', action: 'pause' }); owner.send({ type: 'finish' });
    await room.finalization;
    assert.equal(writer.marks.filter(m => m.kind === 'pause').length, 2, 'ending a paused match settles its pause');
  } finally { await h.service.close(); }

  const closed = roomHarness({ devTools: 'owner' }), shut = closed.live();
  try {
    const guest = closed.joined(shut.room, {}), before = shut.room.match.tick;
    guest.send({ type: 'dev', action: 'pause' }); closed.wake(100);
    assert.ok(shut.room.match.tick > before, 'a session the policy does not admit cannot pause');
    shut.owner.send({ type: 'dev', action: 'pause' });
    assert.equal(shut.room.pausedAt != null, true, 'under `owner`, the owner can');
  } finally { await closed.service.close(); }
});

test('a dev teleport moves any active player to open ground, is recorded, and shows while paused', async () => {
  const h = roomHarness({ devTools: 'owner' }), { room, owner, writer } = h.live();
  try {
    const id = owner.session.playerId, bot = room.game.players.find(p => p.bot && p.status === 'active');
    const open = room.game.map.spawns[0];
    const guest = h.joined(room, {}); guest.send({ type: 'dev', action: 'teleport', id: bot.id, x: open.x, y: open.y });
    assert.ok(!guest.messages.some(m => m.type === 'teleport'), 'a session the policy does not admit cannot teleport');
    owner.send({ type: 'dev', action: 'teleport', id: bot.id, x: open.x + 0.4, y: open.y });
    assert.deepEqual(owner.messages.at(-1), { type: 'teleport', ok: true, id: bot.id, x: Math.round(open.x + 0.4), y: open.y });
    assert.equal(bot.x, Math.round(open.x + 0.4)); assert.deepEqual(bot.path, [], 'a bot plans again from where it lands');
    h.wake(50);
    assert.deepEqual(writer.frames.at(-1).commands.find(c => c.type === 'teleport'), { type: 'teleport', id: bot.id, x: Math.round(open.x + 0.4), y: open.y });
    const wall = room.game.map.obstacles.find(o => !o.points && o.w > 60 && o.h > 60);
    owner.send({ type: 'dev', action: 'teleport', id, x: wall.x + wall.w / 2, y: wall.y + wall.h / 2 });
    assert.equal(owner.messages.at(-1).ok, false, 'a body cannot be put inside a wall');
    for (const bad of [{ id: 'nobody' }, { id, x: NaN }, { id, x: 1e9, y: 1e9 }]) {
      owner.send({ type: 'dev', action: 'teleport', x: open.x, y: open.y, ...bad });
      assert.equal(owner.messages.at(-1).ok, false, JSON.stringify(bad));
    }
    owner.send({ type: 'dev', action: 'pause' }); const tick = room.match.tick;
    owner.send({ type: 'dev', action: 'teleport', id, x: open.x, y: open.y + 30 });
    const shown = owner.messages.filter(m => m.type === 'state').at(-1).state;
    assert.equal(shown.tick, tick); assert.equal(shown.players.find(p => p.id === id).y, open.y + 30, 'a paused room shows the move at once');
  } finally { await h.service.close(); }
});

test('a backed-up socket skips state frames but never a one-off message', () => {
  assert.equal(deliverable(MAX_BUFFERED_BYTES, true), false);
  assert.equal(deliverable(MAX_BUFFERED_BYTES - 1, true), true);
  assert.equal(deliverable(MAX_BUFFERED_BYTES * 4, false), true);
  const h = roomHarness(), { room } = h.live(), flags = [];
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
  const h = roomHarness(), player = h.peer(); player.send({ type: 'match', role: 'gladiator' });
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
  assert.equal(roomSeed({ seed: '9' }), 9); assert.equal(roomSeed({}, () => 77), 77);
  assert.notEqual(roomSeed({}), roomSeed({}));
  for (const seed of [0, -1, 2147483648, 1.5, 'bad']) assert.equal(roomSeed({ seed }), null);
  assert.deepEqual(roomSize({}), { zoneWidth: 12, zoneHeight: 6 });
  assert.deepEqual(roomSize({ size: '36x18' }), { zoneWidth: 36, zoneHeight: 18 });
  for (const size of ['13x6', '12 x 6', 12, null, '']) assert.equal(roomSize({ size }), null, String(size));
});

test('a catch-up past the cap leaves a server-stall marker on the recording, and normal wakes leave none', async () => {
  const h = roomHarness();
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
  const h = roomHarness();
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
  const h = roomHarness();
  try {
    const { owner, writer } = h.live();
    for (let i = 0; i < 12; i++) h.wake(50, 300);
    const tick = writer.frames.at(-1).state.tick, before = writer.frames.at(-1).commands.length;
    owner.send({ type: 'diagnostic', kind: 'frame-drop', tick: tick - 3, startTick: tick - 9, count: 7.4, worstMs: 120.6 });
    assert.equal(writer.marks.length, 1);
    const [mark] = writer.marks;
    assert.equal(mark.kind, 'frame-drop'); assert.equal(mark.tick, tick - 3); assert.equal(mark.startTick, tick - 9);
    assert.equal(mark.count, 7); assert.equal(mark.worstMs, 121); assert.equal(mark.playerId, owner.session.playerId);
    assert.equal(mark.arrivalTick, tick);
    assert.equal(writer.frames.at(-1).commands.length, before, 'not routed through the recorded inputs');
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

test('diagnostic reports are capped per session and refused from spectators', async () => {
  const h = roomHarness();
  try {
    const { room, owner, writer } = h.live();
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_SESSION + 5; i++) { h.wake(50, 300); owner.send({ type: 'diagnostic', kind: 'manual', tick: 0 }); }
    assert.equal(writer.marks.length, MAX_DIAGNOSTICS_PER_SESSION);
    const watcher = h.peer(); watcher.send({ type: 'join', room: room.id, role: 'spectator' });
    watcher.send({ type: 'diagnostic', kind: 'manual', tick: 0 });
    assert.equal(writer.marks.length, MAX_DIAGNOSTICS_PER_SESSION);
  } finally { await h.service.close(); }
});

test('a room created at a larger size starts, advertises it and records that map', () => {
  const h = roomHarness(), size = { zoneWidth: 24, zoneHeight: 12 };
  const room = h.service.makeRoom(9, false, size), owner = h.joined(room, { ownerKey: room.ownerKey });
  assert.equal(owner.messages.find(m => m.type === 'lobby').size, '24x12');
  owner.send({ type: 'start' });
  const { header } = h.writers.get(room.id);
  assert.deepEqual([header.map.width, header.map.height], [34560, 17280]);
  assert.equal(room.game.map.width, 34560);
});
