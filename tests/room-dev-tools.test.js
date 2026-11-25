import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';

test('the dev view follows the server policy and sees the current directed frame', async () => {
  const closed = roomHarness({ reuseMaps: true }), shut = await closed.live();
  try {
    const refused = closed.joined(shut.room, { mode: 'dev', ownerKey: shut.room.ownerKey });
    assert.match(refused.messages[0].message, /not enabled/);
    assert.equal(shut.owner.messages.find(m => m.type === 'welcome').devTools, false, 'players are told when the dev view is off');
  } finally { await closed.service.close(); }

  const owned = roomHarness({ devTools: 'owner', reuseMaps: true }), mine = await owned.live();
  try {
    assert.match(owned.joined(mine.room, { mode: 'dev' }).messages[0].message, /owner key/);
    assert.equal(owned.joined(mine.room, { mode: 'dev', ownerKey: mine.room.ownerKey }).session.dev, true);
    assert.equal(owned.joined(mine.room, {}).messages.find(m => m.type === 'welcome').devTools, false, 'a joiner without the key is not offered it');
  } finally { await owned.service.close(); }

  const h = roomHarness({ devTools: 'all', reuseMaps: true }), { room, owner, writer } = await h.live();
  try {
    assert.equal(owner.messages.find(m => m.type === 'welcome').devTools, true);
    const dev = h.joined(room, { mode: 'dev' }), welcome = dev.messages[0];
    assert.equal(welcome.dev, true); assert.equal(welcome.id, null); assert.equal(Object.hasOwn(welcome.state, 'self'), false, 'directed');
    assert.equal(dev.session.playerId, null); assert.equal(room.match.roster().length, 1, 'the dev view holds no slot');
    const spectator = h.joined(room, { mode: 'spectator', ownerKey: room.ownerKey });
    for (let i = 0; i < 70; i++) h.wake(50);
    const live = dev.messages.at(-1).state, delayed = spectator.messages.at(-1).state;
    assert.equal(live.tick, room.match.tick, 'the dev view is not delayed');
    assert.equal(Object.hasOwn(live, 'self'), false); assert.ok(live.players.every(p => 'x' in p));
    assert.ok(room.match.tick - delayed.tick >= 55, 'the ordinary spectator delay is unchanged');
    dev.send({ type: 'input', seq: 1, x: 1 }); dev.send({ type: 'start' }); h.wake(50);
    assert.ok(!writer.frames.at(-1).commands.length, 'a dev view sends no commands');
    h.service.disconnect(dev.session); h.service.disconnect(spectator.session);
    assert.equal(room.spectators, 0);
  } finally { await h.service.close(); }
});

test('a dev pause stops only its own room, drops owed time and leaves one mark', async () => {
  const h = roomHarness({ devTools: 'all', reuseMaps: true }), { room, owner, writer } = await h.live(), other = await h.live();
  try {
    const dev = h.joined(room, { mode: 'dev' });
    h.wake(100); const tick = room.match.tick;
    dev.send({ type: 'dev', action: 'pause' });
    assert.deepEqual(owner.messages.at(-1), { type: 'paused', paused: true });
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

  const closed = roomHarness({ devTools: 'owner', reuseMaps: true }), shut = await closed.live();
  try {
    const guest = closed.joined(shut.room, {}), before = shut.room.match.tick;
    guest.send({ type: 'dev', action: 'pause' }); closed.wake(100);
    assert.ok(shut.room.match.tick > before, 'a session the policy does not admit cannot pause');
    shut.owner.send({ type: 'dev', action: 'pause' });
    assert.equal(shut.room.pausedAt != null, true, 'under `owner`, the owner can');
  } finally { await closed.service.close(); }
});

test('a dev teleport moves any active player to open ground, is recorded, and shows while paused', async () => {
  const h = roomHarness({ devTools: 'owner', reuseMaps: true }), { room, owner, writer } = await h.live();
  try {
    const id = owner.session.playerId, bot = room.game.players.find(p => p.bot && p.status === 'active');
    // Every spawn holds an actor, and a body is refused a point that overlaps another, so open ground is found by asking:
    // the first point near the spawn the room accepts (the answer, not the search, is what is checked).
    const spawn = room.game.map.spawns[0], used = new Set();
    const offsets = []; for (let r = 1; r <= 6; r++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) offsets.push([dx * r * 60, dy * r * 60]);
    const land = target => {
      for (const [dx, dy] of offsets) {
        if (used.has(`${dx} ${dy}`)) continue;
        owner.send({ type: 'dev', action: 'teleport', id: target, x: spawn.x + dx + 0.4, y: spawn.y + dy });
        if (room.pausedAt == null) h.wake(50);
        const answer = owner.messages.findLast(m => m.type === 'teleport');
        if (answer.ok) { used.add(`${dx} ${dy}`); return { answer, x: spawn.x + dx, y: spawn.y + dy }; }
      }
      assert.fail('no open ground near the spawn');
    };
    const guest = h.joined(room, {}); guest.send({ type: 'dev', action: 'teleport', id: bot.id, x: spawn.x + 60, y: spawn.y });
    assert.ok(!guest.messages.some(m => m.type === 'teleport'), 'a session the policy does not admit cannot teleport');
    const first = land(bot.id);
    assert.deepEqual(first.answer, { type: 'teleport', ok: true, id: bot.id });
    assert.ok(Math.hypot(bot.x - first.x, bot.y - first.y) < 20, 'the warp precedes the solve');
    assert.deepEqual(writer.frames.at(-1).commands.find(c => c.kind === 'teleport'),
      { type: 'observation', kind: 'teleport', body: `actor:${bot.id}`, x: Math.round(first.x + 0.4), y: first.y });
    land(id);
    // The map is immutable, so the solid collider is the map's largest building rather than one arranged here.
    const wall = room.game.map.obstacles.filter(o => o.kind === 'building').reduce((a, b) => b.w * b.h > a.w * a.h ? b : a);
    owner.send({ type: 'dev', action: 'teleport', id, x: wall.x + wall.w / 2, y: wall.y + wall.h / 2 });
    h.wake(50);
    assert.equal(owner.messages.findLast(m => m.type === 'teleport').ok, false, 'a body cannot be put inside a wall');
    for (const bad of [{ id: 'nobody' }, { id, x: NaN }, { id, x: 1e9, y: 1e9 }]) {
      owner.send({ type: 'dev', action: 'teleport', x: first.x, y: first.y, ...bad });
      h.wake(50);
      assert.equal(owner.messages.findLast(m => m.type === 'teleport').ok, false, JSON.stringify(bad));
    }
    owner.send({ type: 'dev', action: 'pause' }); const tick = room.match.tick;
    const moved = land(id);
    const shown = owner.messages.filter(m => m.type === 'state').at(-1).state;
    assert.ok(shown.tick > tick); assert.ok(Math.abs(shown.players.find(p => p.id === id).y - moved.y) < 0.001, 'a paused room shows the stored body pose at once');
    assert.ok(Math.abs(shown.players.find(p => p.id === id).x - Math.round(moved.x + 0.4)) < 0.001);
  } finally { await h.service.close(); }
});

test('teleports in a paused room never shorten the spectator delay', async () => {
  const h = roomHarness({ devTools: 'owner', reuseMaps: true }), { room, owner } = await h.live();
  try {
    for (let i = 0; i < 100; i++) h.wake(50);
    const eye = h.joined(room, { mode: 'spectator', ownerKey: room.ownerKey });
    owner.send({ type: 'dev', action: 'pause' });
    const id = owner.session.playerId, open = room.game.map.spawns[0];
    for (let i = 0; i < 65; i++) owner.send({ type: 'dev', action: 'teleport', id, x: open.x, y: open.y + (i % 2) * 20 });
    assert.equal(room.history.filter(frame => frame.tick === room.match.tick).length, 1, 'one history entry per tick');
    assert.equal(room.history[0].tick, room.match.tick - 61);
    assert.equal(eye.messages.at(-1).state.tick, room.match.tick - 60, 'the spectator still sees the delayed frame');
  } finally { await h.service.close(); }
});

test('each connection reads state in the encoding it negotiated, and JSON only with dev tools', async () => {
  const closed = roomHarness({ reuseMaps: true }), shut = await closed.live();
  try {
    // Binary by default: the welcome confirms it and every state message is the codec's bytes (24.1).
    assert.equal(shut.owner.messages.find(m => m.type === 'welcome').stateEncoding, 'binary');
    closed.wake(50);
    assert.deepEqual([...new Set(shut.owner.binary)], ['state'], 'only state is binary');
    const refused = closed.joined(shut.room, { stateEncoding: 'json', ownerKey: shut.room.ownerKey });
    assert.match(refused.messages[0].message, /debug encoding/, 'JSON state without dev tools is refused, not downgraded');
    assert.equal(refused.messages.length, 1);
  } finally { await closed.service.close(); }

  // Under `owner` the debug encoding follows the owner key, as the dev view does.
  const owned = roomHarness({ devTools: 'owner', reuseMaps: true }), mine = await owned.live();
  try {
    assert.equal(owned.joined(mine.room, { stateEncoding: 'json', ownerKey: mine.room.ownerKey }).messages[0].stateEncoding, 'json');
    assert.match(owned.joined(mine.room, { stateEncoding: 'json' }).messages[0].message, /debug encoding/);
  } finally { await owned.service.close(); }

  const h = roomHarness({ devTools: 'all', reuseMaps: true }), { room } = await h.live();
  try {
    const text = h.joined(room, { mode: 'dev', stateEncoding: 'json' }), bytes = h.joined(room, { mode: 'dev' });
    assert.equal(text.messages[0].stateEncoding, 'json'); assert.equal(bytes.messages[0].stateEncoding, 'binary');
    for (let i = 0; i < 3; i++) h.wake(50);
    assert.deepEqual(text.binary, [], 'a JSON connection is sent text only');
    // The same view in either encoding reads as the same frames.
    const states = p => p.messages.filter(m => m.type === 'state').map(m => m.state);
    assert.ok(states(text).length >= 3);
    assert.deepEqual(states(text), states(bytes));
  } finally { await h.service.close(); }
});
