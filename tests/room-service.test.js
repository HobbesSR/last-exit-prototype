import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { createMatch } from '../server/match.js';
import { createGame, joinGame, setInput, step, snapshot } from '../shared/simulation.ts';

test('three hunter places are advertised, admitted, reclaimed and recorded', async () => {
  const h = roomHarness(), room = h.service.makeRoom(9);
  try {
    const owner = h.joined(room, { ownerKey: room.ownerKey });
    const hunters = ['warden', 'specter', 'striker'].map(kit => h.joined(room, { role: 'gladiator', kit }));
    const lobby = owner.messages.filter(m => m.type === 'lobby').at(-1);
    assert.deepEqual(lobby.capacity, { contestant: 8, gladiator: 3 });
    assert.equal(lobby.players.filter(p => p.role === 'gladiator').length, 3);
    assert.ok(hunters.every(p => p.session.playerId));
    // Before the start a full side places the player on the other, where the lobby lets them change (#235).
    const fourth = h.joined(room, { role: 'gladiator' });
    assert.equal(room.match.player(fourth.session.playerId).role, 'contestant');
    fourth.send({ type: 'choose', role: 'gladiator', kit: 'specter' });
    assert.match(fourth.messages.at(-1).message, /No gladiator places/);
    assert.equal(fourth.messages.at(-1).ok, false);
    h.service.disconnect(fourth.session);
    const third = hunters[2], welcome = third.messages.find(m => m.type === 'welcome');
    h.service.disconnect(third.session);
    const resumed = h.joined(room, { resumeKey: welcome.resumeKey });
    assert.equal(resumed.session.playerId, welcome.id);
    assert.equal(room.match.player(welcome.id).kit, 'striker');
    owner.send({ type: 'start' });
    const writer = h.writers.get(room.id);
    assert.equal(writer.header.contentId, 'content-5');
    assert.equal(writer.header.version, 'last-exit-0.7');
    assert.equal(writer.header.schema, 9);
    assert.equal(writer.header.minSchema, 4);
    assert.equal(writer.frames[0].state.players.filter(p => p.role === 'gladiator').length, 3);
    assert.equal(writer.frames[0].state.slots, 3);
  } finally { await h.service.close(); }
});

test('a player changes role and kit in the lobby, freeing their place to its roster bot, until the start', async () => {
  const h = roomHarness(), room = h.service.makeRoom(9);
  try {
    const owner = h.joined(room, { ownerKey: room.ownerKey, name: 'Owner' });
    const runner = h.joined(room, { name: 'Runner' }), id = runner.session.playerId;
    const fresh = createGame(9, room.match.map(), room.content).players;
    const before = room.match.player(id);
    assert.equal(before.role, 'contestant');

    runner.send({ type: 'choose', role: 'gladiator', kit: 'striker' });
    assert.deepEqual(room.match.player(id), { id, name: 'Runner', role: 'gladiator', kit: 'striker' }, 'the same player, now a hunter');
    assert.equal(runner.messages.at(-1).type, 'lobby');
    // Shown in their new role in the waiting area (#236), never from the match place itself before the start.
    assert.ok(!runner.messages.some(m => m.type === 'ready'));
    h.wake(50);
    assert.ok(runner.messages.findLast(m => m.type === 'state').state.players.some(p => p.id === id && p.role === 'gladiator' && p.kit === 'striker'), 'shown in the new role');
    assert.deepEqual(owner.messages.findLast(m => m.type === 'lobby').players.find(p => p.id === id), { id, name: 'Runner', role: 'gladiator', kit: 'striker' });
    const players = room.game.players;
    assert.equal(new Set(players.map(p => p.id)).size, players.length, 'identifiers stay unique');
    // The contestant place they left is its roster bot again, where it stood.
    const place = ({ id, name, role, kit, bot, x, y }) => ({ id, name, role, kit, bot, x, y });
    const left = players.filter(p => p.role === 'contestant')[1], bot = fresh.filter(p => p.role === 'contestant')[1];
    assert.deepEqual(place(left), place(bot));

    runner.send({ type: 'choose', role: 'gladiator', kit: 'specter' });
    assert.equal(room.match.player(id).kit, 'specter', 'a kit changes in place');
    runner.send({ type: 'choose', role: 'gladiator', kit: 'no-such-kit' });
    assert.equal(room.match.player(id).kit, 'specter', 'a kit the content lacks is ignored');
    runner.send({ type: 'choose', role: 'spectator' });
    assert.equal(runner.messages.at(-1).ok, false);
    assert.equal(room.match.player(id).role, 'gladiator');

    owner.send({ type: 'start' });
    const commands = h.writers.get(room.id).frames[0].commands;
    assert.deepEqual(commands.filter(c => c.type === 'choose'), [
      { type: 'choose', id, role: 'gladiator', kit: 'striker' },
      { type: 'choose', id, role: 'gladiator', kit: 'specter' },
      { type: 'choose', id, role: 'gladiator', kit: 'specter' }
    ]);
    runner.send({ type: 'choose', role: 'contestant' });
    assert.equal(room.match.player(id).role, 'gladiator', 'no change once the match has started');
  } finally { await h.service.close(); }
});

test('a private match already under way admits only the role asked for', async () => {
  const h = roomHarness();
  try {
    const { room } = h.live();
    for (let i = 0; i < 3; i++) h.joined(room, { role: 'gladiator' });
    const late = h.joined(room, { role: 'gladiator' });
    assert.match(late.messages[0].message, /No gladiator places/);
    assert.equal(late.session.playerId, null);
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
