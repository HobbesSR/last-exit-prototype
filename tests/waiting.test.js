import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { waitingYard } from '../shared/waiting-yard.ts';
import { createWaiting, enterWaiting, leaveWaiting, waitingInput, stepWaiting, waitingView } from '../shared/simulation/waiting.ts';
import { canOccupy } from '../shared/movement.ts';

const frames = peer => peer.messages.filter(m => m.type === 'state').map(m => m.state);

test('every arrival point in the waiting yard fits the biggest body', () => {
  const yard = waitingYard();
  assert.ok(yard.spawns.length >= 11, 'room for a full roster without stacking');
  for (const at of yard.spawns) assert.ok(canOccupy(yard, at.x, at.y, 23), `${at.x},${at.y}`);
  assert.equal(yard.exit, undefined, 'nothing to escape to');
});

test('the waiting simulation walks people, shows everyone, and keeps their place across a role change', () => {
  const w = createWaiting(waitingYard());
  const a = enterWaiting(w, 'a', 'contestant', 'warden', 'Ada'), start = { x: a.x, y: a.y };
  enterWaiting(w, 'b', 'gladiator', 'striker', 'Bo');
  for (let seq = 0; seq < 5; seq++) assert.equal(waitingInput(w, 'a', { seq, x: 1, y: 0, attack: true }), true);
  assert.equal(waitingInput(w, 'a', { seq: 2, x: 1 }), false, 'a stale input is refused');
  assert.equal(waitingInput(w, 'nobody', { seq: 9, x: 1 }), false);
  for (let i = 0; i < 4; i++) stepWaiting(w);
  const walked = w.players.find(p => p.id === 'a');
  assert.ok(walked.x > start.x, 'moved east'); assert.equal(walked.lastSeq, 4, 'the queue holds four, so the first was dropped');
  assert.equal(walked.hp, walked.maxHp, 'an attack does nothing here');

  enterWaiting(w, 'a', 'gladiator', 'specter', 'Ada');
  const changed = w.players.find(p => p.id === 'a');
  assert.deepEqual({ x: changed.x, y: changed.y, role: changed.role, kit: changed.kit, lastSeq: changed.lastSeq }, { x: walked.x, y: walked.y, role: 'gladiator', kit: 'specter', lastSeq: 4 });
  assert.equal(w.players.length, 2, 'the same person, not another');

  const view = waitingView(w, 'b');
  assert.equal(view.phase, 'waiting');
  assert.deepEqual(view.players.map(p => p.id), ['a', 'b']);
  assert.equal(view.players[0].inputQueue, undefined, 'others are described as a match describes them');
  assert.equal(view.players[1].lastSeq, -1, 'the viewer gets their own fields');
  leaveWaiting(w, 'a');
  assert.deepEqual(w.players.map(p => p.id), ['b']);
});

test('players wait in the yard, never see the match map before the start, and walking there changes no match', async () => {
  // Two rooms with the same seed: in one the players walk about before the start, in the other they do not.
  const run = walk => {
    const h = roomHarness(), room = h.service.makeRoom(9);
    const owner = h.joined(room, { ownerKey: room.ownerKey, name: 'Owner' });
    const runner = h.joined(room, { name: 'Runner', role: 'gladiator', kit: 'specter' });
    for (const peer of [owner, runner]) {
      const welcome = peer.messages.find(m => m.type === 'welcome');
      assert.equal(welcome.map.generator, 'waiting-yard-1', 'shown the yard, not the arena');
      assert.equal(welcome.state.phase, 'waiting');
    }
    if (walk) for (let seq = 0; seq < 30; seq++) { runner.send({ type: 'input', seq, x: -1, y: 1, aim: 2 }); owner.send({ type: 'input', seq, x: 1, y: -1 }); h.wake(50); }
    else h.wake(50 * 30);
    const waited = frames(runner).at(-1);
    assert.deepEqual(waited.players.map(p => p.name), ['Owner', 'Runner'], 'people only, no bots');
    assert.ok(!owner.messages.concat(runner.messages).some(m => m.type === 'ready'), 'the match map stays hidden');
    owner.send({ type: 'start' });
    const ready = runner.messages.findLast(m => m.type === 'ready');
    assert.notEqual(ready.map.generator, 'waiting-yard-1', 'the start brings the match map');
    assert.equal(ready.state.phase, 'live');
    assert.equal(room.waiting, null);
    h.wake(50 * 3);
    return { h, waited, recorded: h.writers.get(room.id).frames, runner };
  };
  const walked = run(true), still = run(false);
  try {
    assert.ok(walked.waited.players.find(p => p.name === 'Runner').x < still.waited.players.find(p => p.name === 'Runner').x, 'walking moved them');
    // Ids are per connection, so compare the match with them taken out.
    const neutral = frames => JSON.parse(JSON.stringify(frames).replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"id"'));
    assert.deepEqual(neutral(walked.recorded), neutral(still.recorded), 'the recording is the same either way');
    assert.ok(!walked.recorded.flatMap(f => f.commands).some(c => c.type === 'input' && c.input.y === 1 && c.input.x === -1), 'walking is never recorded');
    assert.equal(frames(walked.runner).at(-1).phase, 'live');
  } finally { await walked.h.service.close(); await still.h.service.close(); }
});

test('someone who leaves before the start leaves the yard, and a resume brings them back', async () => {
  const h = roomHarness(), room = h.service.makeRoom(9);
  try {
    const owner = h.joined(room, { ownerKey: room.ownerKey, name: 'Owner' });
    const runner = h.joined(room, { name: 'Runner' }), welcome = runner.messages.find(m => m.type === 'welcome');
    h.service.disconnect(runner.session);
    h.wake(50);
    assert.deepEqual(frames(owner).at(-1).players.map(p => p.name), ['Owner']);
    const back = h.joined(room, { resumeKey: welcome.resumeKey });
    assert.equal(back.session.playerId, welcome.id);
    h.wake(50);
    assert.deepEqual(frames(owner).at(-1).players.map(p => p.name), ['Owner', 'Runner']);
  } finally { await h.service.close(); }
});

test('a room still generating its map already has a waiting yard', async () => {
  let release;
  const h = roomHarness(), room = h.service.makeRoom(9, false, undefined, new Promise(resolve => { release = resolve; }));
  try {
    const runner = h.joined(room, { name: 'Runner' });
    assert.equal(room.match, null);
    assert.equal(runner.messages.find(m => m.type === 'welcome').map.generator, 'waiting-yard-1');
    runner.send({ type: 'input', seq: 0, x: 1 }); h.wake(50);
    assert.equal(frames(runner).length, 1);
    release(undefined);
    await room.ready;
    assert.ok(room.match);
    assert.ok(!runner.messages.some(m => m.type === 'ready'), 'the map arriving does not reveal it');
  } finally { await h.service.close(); }
});
