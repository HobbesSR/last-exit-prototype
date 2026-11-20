import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlayer, joinGame, changeSeat } from '../shared/simulation/state.ts';
import { gateAt, indexRoster, playerById, playerIndex } from '../shared/simulation/relations.ts';
import { asSeenBy, recordRewind } from '../shared/simulation/rewind.ts';

const roster = () => ({ phase: 'live', players: [
  makePlayer('c0', 'C0', 'contestant', 'runner', 0),
  makePlayer('g0', 'G0', 'gladiator', 'hook', 0),
], content: { kits: { runner: {}, hook: {} }, roster: {
  contestants: ['C0'], gladiators: [{ name: 'G0', kit: 'hook' }],
} } });

test('dense player slots survive join and role changes while old frame identities stay detached', () => {
  const s = roster(), before = structuredClone(s), original = JSON.stringify(s.players);
  indexRoster(s.players);
  assert.equal(JSON.stringify(s.players), original);
  const joined = joinGame(s, 'human', 'contestant', 'runner', 'Human');
  assert.equal(playerById(s, 'human'), joined);
  assert.equal(playerById(s, 'c0'), undefined);
  const beforeKitChange = indexRoster(s.players);
  assert.equal(changeSeat(s, 'human', 'contestant', 'runner'), joined);
  assert.equal(indexRoster(s.players), beforeKitChange);
  const beforeReassignment = indexRoster(s.players);
  const moved = changeSeat(s, 'human', 'gladiator', 'hook');
  assert.notEqual(indexRoster(s.players), beforeReassignment);
  assert.equal(playerById(s, 'human'), moved);
  assert.equal(playerById(s, 'c0'), s.players[0]);
  assert.equal(playerById(before, 'human'), undefined);
  assert.equal(playerById(before, 'c0'), before.players[0]);
  assert.equal(playerById(s, 'g0'), undefined);
});

test('repeated unknown IDs reuse the roster index, including spectator and trap-like labels', () => {
  const s = roster();
  const indexed = indexRoster(s.players);
  for (const id of ['spectator', 'trap:actor:c0', 'trap:item:item-2', 'spectator'])
    assert.equal(playerById(s, id), undefined);
  assert.equal(indexRoster(s.players), indexed);
});

test('roster edits refresh ID lookup and later misses reuse the refreshed index', () => {
  const s = roster();
  let indexed = indexRoster(s.players);

  s.players[0].id = 'renamed';
  assert.equal(playerById(s, 'renamed'), s.players[0]);
  assert.equal(playerById(s, 'c0'), undefined);
  assert.notEqual(indexRoster(s.players), indexed);
  indexed = indexRoster(s.players);

  const added = makePlayer('added', 'Added', 'contestant', 'runner', 2);
  s.players.push(added);
  assert.equal(playerById(s, 'added'), added);
  assert.notEqual(indexRoster(s.players), indexed);
  indexed = indexRoster(s.players);

  s.players.splice(2, 1);
  assert.equal(playerById(s, 'added'), undefined);
  assert.notEqual(indexRoster(s.players), indexed);
  indexed = indexRoster(s.players);

  const replacement = makePlayer('replacement', 'Replacement', 'contestant', 'runner', 3);
  s.players[1] = replacement;
  assert.equal(playerById(s, 'replacement'), replacement);
  assert.equal(playerById(s, 'g0'), undefined);
  assert.notEqual(indexRoster(s.players), indexed);

  s.players.reverse();
  assert.equal(playerById(s, 'replacement'), replacement);

  const refreshed = indexRoster(s.players);
  for (const id of ['spectator', 'trap:body:actor:g0']) assert.equal(playerById(s, id), undefined);
  assert.equal(indexRoster(s.players), refreshed);
});

test('legacy diagnostic edits refresh lookup without attaching substrate fields', () => {
  const s = roster();
  assert.equal(playerById(s, 'c0'), s.players[0]);
  let indexed = indexRoster(s.players);
  s.players[0].id = 'renamed';
  assert.equal(playerById(s, 'renamed'), s.players[0]);
  assert.notEqual(indexRoster(s.players), indexed);
  indexed = indexRoster(s.players);
  assert.equal(playerById(s, 'c0'), undefined);
  assert.equal(indexRoster(s.players), indexed);
  assert.equal(Object.keys(s.players[0]).some(key => /idx|index/i.test(key)), false);
  const gates = [{ id: 'door-2' }, { id: 'door-10' }];
  assert.equal(gateAt({ gates }, 1), gates[1]);
});

test('dense player slots survive joins, role changes, and metadata renames', () => {
  const s = roster(), [contestant, gladiator] = s.players;
  assert.equal(playerIndex(s, contestant), 0);
  assert.equal(playerIndex(s, gladiator), 1);
  const joined = joinGame(s, 'human', 'contestant', 'runner', 'Human');
  assert.equal(playerIndex(s, contestant), 0);
  assert.equal(playerIndex(s, gladiator), 1);
  assert.equal(playerIndex(s, joined), 0);

  const moved = changeSeat(s, 'human', 'gladiator', 'hook');
  assert.notEqual(moved, joined);
  moved.name = 'Renamed';
  joined.name = 'Former seat';
  assert.equal(playerIndex(s, moved), 1);
  assert.equal(playerIndex(s, joined), 0);
  assert.equal(playerIndex(s, contestant), 0);
  assert.equal(playerIndex(s, gladiator), 1);
});

test('rewind poses remain aligned to player slots when an ID label changes', () => {
  const s = roster(), [target, viewer] = s.players;
  Object.assign(target, { x: 123, y: 456 });
  Object.assign(viewer, { x: 789, y: 234, viewLagTicks: 1 });
  s.tick = 7;
  recordRewind(s);

  assert.deepEqual(s.rewind[0].at[0], { x: 123, y: 456 });
  target.id = 'new-label';
  Object.assign(target, { x: 900, y: 901 });
  assert.deepEqual(asSeenBy(s, viewer)(target), { x: 123, y: 456 });
});
