import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { createMatch } from '../server/match.js';
import { createGame, joinGame, setInput, step, snapshot } from '../shared/simulation.js';
import { parseMessage, acceptMessageRate, roomSeed } from '../server/protocol.js';

test('match boundary preserves simulation output and returns detached commands, identities and maps', () => {
  const match = createMatch(9), game = createGame(9);
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
  writer.blocked = true; h.wake(200); assert.equal(room.match.tick, 6);
  writer.blocked = false; h.wake(0); assert.equal(room.match.tick, 10);
  assert.equal(room.debt, 0); await h.service.close();
});

test('room command recording owns sanitized latched inputs independently of later ticks', async () => {
  const h = roomHarness(), { owner, writer } = h.live();
  owner.send({ type: 'input', seq: 1, interact: true, moveSlot: { from: 0, to: 5 }, hp: 999 });
  owner.send({ type: 'input', seq: 2, x: 1 }); h.wake(50);
  const inputs = writer.frames.at(-1).commands.filter(c => c.type === 'input');
  assert.equal(inputs.length, 2); assert.equal(inputs[0].input.interact, true);
  assert.deepEqual(inputs[1].input.moveSlot, { from: 0, to: 5 }); assert.equal(inputs[0].input.hp, undefined);
  assert.equal(writer.frames.at(-1).state.players.find(p => p.id === owner.session.playerId).input.interact, false);
  await h.service.close();
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
  assert.equal(roomSeed({ seed: '9' }), 9); assert.equal(roomSeed({}), 4217);
  for (const seed of [0, -1, 2147483648, 1.5, 'bad']) assert.equal(roomSeed({ seed }), null);
});
