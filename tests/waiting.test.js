import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { waitingYard } from '../shared/waiting-yard.ts';
import { createWaiting, enterWaiting, changeWaiting, leaveWaiting, waitingInput, waitingSanitizedInput, stepWaiting, waitingView, waitingSeats, waitingConstants } from '../shared/simulation/waiting.ts';
import { canOccupy } from '../shared/movement.ts';
import { CLIENT_MESSAGE, validateClientMessage } from '../shared/protocol.ts';

const frames = peer => peer.messages.filter(m => m.type === 'state').map(m => m.state);

test('every arrival point in the waiting yard fits the biggest body', () => {
  const yard = waitingYard();
  assert.ok(yard.spawns.length >= 11, 'room for a full roster without stacking');
  for (const at of yard.spawns) assert.ok(canOccupy(yard, at.x, at.y, 23), `${at.x},${at.y}`);
  assert.equal(yard.exit, undefined, 'nothing to escape to');
});

test('the waiting simulation walks people, shows everyone, and keeps their place across a role change', async () => {
  const w = createWaiting(waitingYard());
  await w.ready;
  try {
    const a = enterWaiting(w, 'a', 'contestant', 'warden', 'Ada'), start = { x: a.x, y: a.y };
    enterWaiting(w, 'b', 'gladiator', 'striker', 'Bo');
    for (let seq = 0; seq < 5; seq++) assert.equal(waitingInput(w, 'a', { seq, x: 1, y: 0, attack: true }), true);
    assert.equal(waitingInput(w, 'a', { seq: 2, x: 1 }), false, 'a stale input is refused');
    assert.equal(waitingInput(w, 'nobody', { seq: 9, x: 1 }), false);
    for (let i = 0; i < 4; i++) stepWaiting(w);
    const walked = w.players.find(p => p.id === 'a');
    assert.ok(walked.x > start.x, 'moved east'); assert.equal(walked.lastSeq, 4, 'the queue holds four, so the first was dropped');
    assert.equal(walked.hp, walked.maxHp, 'an attack does nothing here');
    walked.inputLeadTicks = 5;

    assert.equal(changeWaiting(w, 'nobody', 'gladiator', 'specter'), null);
    changeWaiting(w, 'a', 'gladiator', 'specter');
    const changed = w.players.find(p => p.id === 'a');
    assert.equal(changed.inputLeadTicks, 5, 'a same-connection role/kit change keeps the measured input lead');
    assert.deepEqual({ x: changed.x, y: changed.y, role: changed.role, kit: changed.kit, lastSeq: changed.lastSeq }, { x: walked.x, y: walked.y, role: 'gladiator', kit: 'specter', lastSeq: 4 });
    assert.equal(waitingInput(w, 'a', { seq: 5, tick: w.tick + 1 + changed.inputLeadTicks + 1 }), false, 'a stamp beyond the preserved lead is refused');
    assert.equal(waitingInput(w, 'a', { seq: 6, tick: w.tick + 1 + changed.inputLeadTicks }), true, 'the preserved lead remains the accepted boundary');
    assert.equal(w.players.length, 2, 'the same person, not another');

    const view = waitingView(w, 'b');
    assert.equal(view.phase, 'waiting');
    // The yard's prediction constants come with its map, not in each frame (24.3 proposal 3).
    assert.equal(Object.hasOwn(view, 'physicsProfile') || Object.hasOwn(view, 'predictionMotor'), false);
    assert.deepEqual(waitingConstants(), { physicsProfile: 'last-exit-0.8-physics', predictionMotor: { acceleration: 3600, braking: 3600, maxSpeed: 600, surfaces: true } });
    assert.equal(view.bodies.length, 2);
    const ownBody = view.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === 1);
    assert.ok(ownBody);
    assert.equal(typeof ownBody.vx, 'number');
    assert.equal(typeof ownBody.vy, 'number');
    const otherBody = view.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === 0);
    assert.ok(otherBody);
    assert.equal(otherBody.vx, undefined);

    assert.deepEqual(view.players.map(p => p.playerIdx), [0]);
    assert.equal(view.players[0].inputQueue, undefined, 'others are described as a match describes them');
    assert.equal(view.self.lastSeq, -1, 'the viewer gets their own fields');
    assert.equal(view.self.x, undefined, 'a player with a body has no duplicate pose');
    assert.equal(view.players[0].x, undefined);

    // Simulate initialization and a partial capture without creating another physics world.
    const world = w.world;
    try {
      w.world = null;
      const bodyless = waitingView(w, 'b');
      assert.deepEqual({ x: bodyless.self.x, y: bodyless.self.y }, { x: w.players[1].x, y: w.players[1].y });
      assert.deepEqual({ x: bodyless.players[0].x, y: bodyless.players[0].y }, { x: w.players[0].x, y: w.players[0].y });
      const snapshot = world.snapshot({ includeStatic: false });
      w.world = {
        snapshot: () => ({ ...snapshot, bodies: snapshot.bodies.filter(b => b.spec.id === 'actor:b') }),
        bodyLifetime: id => world.bodyLifetime(id)
      };
      const partial = waitingView(w, 'b');
      assert.equal(partial.self.x, undefined);
      assert.deepEqual({ x: partial.players[0].x, y: partial.players[0].y }, { x: w.players[0].x, y: w.players[0].y });
    } finally { w.world = world; }
    leaveWaiting(w, 'a');
    assert.deepEqual(w.players.map(p => p.id), ['b']);
    const viewAfterLeave = waitingView(w, 'b');
    assert.equal(viewAfterLeave.bodies.length, 1);
  } finally {
    w.dispose();
  }
});

test('players wait in the yard, never see the match map before the start, and walking there changes no match', async () => {
  // Two rooms with the same seed: in one the players walk about before the start, in the other they do not.
  const run = async walk => {
    const h = roomHarness({ reuseMaps: true }), room = await h.room();
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
  const walked = await run(true), still = await run(false);
  try {
    assert.ok(walked.waited.players.find(p => p.name === 'Runner').x < still.waited.players.find(p => p.name === 'Runner').x, 'walking moved them');
    // Ids are per connection, so compare the match with them taken out.
    // The physics world's body list is ordered by those ids, so it is taken out as well; the players and the rest of the frame are compared.
    const neutral = frames => JSON.parse(JSON.stringify(frames).replace(/"(actor:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"id"'),
      (key, value) => key === 'physics' || key === 'bodies' ? undefined : value);
    assert.deepEqual(neutral(walked.recorded), neutral(still.recorded), 'the recording is the same either way');
    assert.ok(!walked.recorded.flatMap(f => f.commands).some(c => c.type === 'input' && c.input.y === 1 && c.input.x === -1), 'walking is never recorded');
    assert.equal(frames(walked.runner).at(-1).phase, 'live');
  } finally { await walked.h.service.close(); await still.h.service.close(); }
});

test('someone who leaves before the start leaves the yard, and a resume brings them back', async () => {
  const h = roomHarness({ reuseMaps: true }), room = await h.room();
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
  const h = roomHarness(), created = h.service.makeRoom(9, false, undefined, new Promise(resolve => { release = resolve; })), room = h.service.rooms.get(created.id);
  try {
    const runner = h.joined(room, { name: 'Runner' });
    assert.equal(room.match, null);
    assert.equal(runner.messages.find(m => m.type === 'welcome').map.generator, 'waiting-yard-1');
    runner.send({ type: 'input', seq: 0, x: 1 }); h.wake(50);
    assert.equal(frames(runner).length, 1);
    release(generatedMap(9));
    await room.ready;
    assert.ok(room.match);
    assert.ok(!runner.messages.some(m => m.type === 'ready'), 'the map arriving does not reveal it');
  } finally { await h.service.close(); }
});

test('a resume replacing a live connection starts the yard input afresh, where the old one stood', async () => {
  const h = roomHarness({ reuseMaps: true }), room = await h.room();
  try {
    h.joined(room, { ownerKey: room.ownerKey, name: 'Owner' });
    const runner = h.joined(room, { name: 'Runner' }), welcome = runner.messages.find(m => m.type === 'welcome');
    for (let seq = 0; seq < 40; seq++) { runner.send({ type: 'input', seq, x: 1 }); h.wake(50); }
    const yard = () => room.waiting.players.find(p => p.id === welcome.id);
    const stood = yard().x;
    // The old socket is still attached when the new one resumes (#267 review).
    const back = h.joined(room, { resumeKey: welcome.resumeKey });
    assert.equal(back.session.playerId, welcome.id);
    const resumed = back.messages.find(m => m.type === 'welcome').state.players.find(p => p.id === welcome.id);
    assert.deepEqual({ x: resumed.x, lastSeq: resumed.lastSeq }, { x: stood, lastSeq: -1 }, 'where they stood, with nothing acknowledged');
    for (let seq = 0; seq < 12; seq++) { back.send({ type: 'input', seq, x: -1 }); h.wake(50); }
    assert.equal(yard().lastSeq, 11, 'the new connection numbers from zero');
    assert.ok(yard().x < stood, 'and walks the way it asks');
  } finally { await h.service.close(); }
});

test('position continuity against obstacles uses actual physics radius (#975 review 771, 773)', async () => {
  const w = createWaiting(waitingYard());
  await w.ready;
  try {
    // Gladiator starts at first arrival point (330, 300) and walks north toward container at y=150..220.
    // Interleaving input and step settles against container with solver contact tolerance at y ≈ 236.227.
    let g = enterWaiting(w, 'g', 'gladiator', 'striker', 'G');
    for (let seq = 0; seq < 80; seq++) {
      waitingInput(w, 'g', { seq, x: 0, y: -1 });
      stepWaiting(w);
    }
    const currentG = () => w.players.find(p => p.id === 'g');
    const stopped = { x: currentG().x, y: currentG().y };
    // Stands within container contact tolerance (distance from y=220 is slightly below 16.25).
    assert.ok(stopped.y - 220 < 16.25, 'stopped by contact with container');
    assert.ok(stopped.y - 220 > 16.0, 'solver contact position');

    // Kit change on unchanged body keeps position and does not advance arrival allocation.
    const arrivalsBefore = w.arrivals;
    g = changeWaiting(w, 'g', 'gladiator', 'specter');
    assert.equal(g.x, stopped.x);
    assert.equal(g.y, stopped.y);
    assert.equal(currentG().x, stopped.x);
    assert.equal(currentG().y, stopped.y);
    assert.equal(w.arrivals, arrivalsBefore);

    // Re-entering (resume) unchanged body at same spot keeps position.
    g = enterWaiting(w, 'g', 'gladiator', 'specter', 'G');
    assert.equal(g.x, stopped.x);
    assert.equal(g.y, stopped.y);
    assert.equal(currentG().x, stopped.x);
    assert.equal(currentG().y, stopped.y);
    assert.equal(w.arrivals, arrivalsBefore);

    // Contestant placed tight against obstacle where contestant (11.2875) fits but gladiator (16.25) cannot.
    // Container bottom edge is at y=220; place contestant at y=233.
    const c = enterWaiting(w, 'c', 'contestant', 'warden', 'C');
    c.x = 330;
    c.y = 233;
    w.world.setTransform('actor:c', { x: 330, y: 233, angle: 0 });
    // Changing role to gladiator cannot fit in the 13 unit gap (needs 16.25), so it teleports to arrival point.
    const arrivalsBeforeTeleport = w.arrivals;
    const changed = changeWaiting(w, 'c', 'gladiator', 'striker');
    assert.equal(w.arrivals, arrivalsBeforeTeleport + 1);
    assert.notEqual(changed.y, 233);
    assert.notEqual(w.players.find(p => p.id === 'c').y, 233);
  } finally {
    w.dispose();
  }
});

test('waiting slots last for the yard: a leaver leaves a gap and the next arrival takes the lowest free slot', async () => {
  const w = createWaiting(waitingYard());
  await w.ready;
  try {
    for (const id of ['a', 'b', 'c']) enterWaiting(w, id, 'contestant', 'warden', id.toUpperCase());
    leaveWaiting(w, 'b');
    const slots = () => Object.fromEntries(waitingSeats(w).map(s => [s.id, s.playerIdx]));
    assert.deepEqual(slots(), { a: 0, c: 2 }, 'c keeps its slot in the roster');
    assert.equal(waitingSeats(w), waitingSeats(w), 'an unchanged yard hands out the same roster, so its seats message is reused');
    const view = waitingView(w, 'a');
    assert.deepEqual(view.players.map(p => p.playerIdx), [2]);
    const body = id => waitingView(w, 'c').bodies.find(b => b.owner.playerIdx === id);
    assert.ok(body(0) && body(2) && !body(1), 'bodies are owned by the stable slots');
    assert.equal(waitingView(w, 'c').self.playerIdx, 2);
    const before = waitingSeats(w);
    changeWaiting(w, 'c', 'gladiator', 'striker'); enterWaiting(w, 'a', 'contestant', 'warden', 'A');
    assert.notEqual(waitingSeats(w), before, 'a change builds a new roster');
    assert.equal(waitingSeats(w).find(s => s.id === 'c').role, 'gladiator');
    assert.deepEqual(slots(), { a: 0, c: 2 }, 'a role change or resume keeps the slot');
    enterWaiting(w, 'd', 'contestant', 'warden', 'D');
    assert.deepEqual(slots(), { a: 0, d: 1, c: 2 }, 'the newcomer takes the freed slot');
    assert.deepEqual(waitingSeats(w).map(s => s.playerIdx), [0, 1, 2], 'the roster is ordered by slot');
  } finally { w.dispose(); }
});

test('waiting admission distinguishes raw markers from validated failed nominations', async () => {
  const w = createWaiting(waitingYard());
  await w.ready;
  try {
    const p = enterWaiting(w, 'a', 'contestant', 'warden', 'Ada');
    assert.equal(waitingInput(w, 'a', { seq: NaN }), false);
    assert.equal(waitingInput(w, 'a', { seq: 0, target: { kind: 'unresolved' }, transit: 's1' }), true);
    assert.equal(p.inputQueue[0].target, undefined);
    assert.equal(p.inputQueue[0].interact, false);
    assert.equal(p.inputQueue[0].transit, undefined);
    const validated = validateClientMessage({ type: CLIENT_MESSAGE.INPUT, seq: 1, tick: 1, interact: true, target: { kind: 'unresolved' }, transit: 's1' });
    assert.equal(validated.ok, true);
    const { type: _type, ...input } = validated.message;
    assert.equal(waitingSanitizedInput(w, 'a', input), true);
    assert.deepEqual(p.inputQueue[0].target, { kind: 'unresolved' });
    assert.equal(p.inputQueue[0].interact, false);
    assert.equal(p.inputQueue[0].transit, undefined);
    assert.equal(waitingSanitizedInput(w, 'a', input), false);
  } finally { w.dispose(); }
});
