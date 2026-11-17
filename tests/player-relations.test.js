import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlayer, joinGame, changeSeat } from '../shared/simulation/state.ts';
import { gateAt, indexRoster, playerById, playerIndex } from '../shared/simulation/relations.ts';

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
  assert.equal(playerIndex(s, s.players[1]), 1);
  const joined = joinGame(s, 'human', 'contestant', 'runner', 'Human');
  assert.equal(playerById(s, 'human'), joined);
  assert.equal(playerIndex(s, joined), 0);
  assert.equal(playerById(s, 'c0'), undefined);
  const moved = changeSeat(s, 'human', 'gladiator', 'hook');
  assert.equal(playerById(s, 'human'), moved);
  assert.equal(playerIndex(s, moved), 1);
  assert.equal(playerById(s, 'c0'), s.players[0]);
  assert.equal(playerById(before, 'human'), undefined);
  assert.equal(playerById(before, 'c0'), before.players[0]);
  assert.equal(playerById(s, 'g0'), undefined);
});

test('legacy diagnostic edits refresh lookup without attaching substrate fields', () => {
  const s = roster();
  assert.equal(playerById(s, 'c0'), s.players[0]);
  s.players[0].id = 'renamed';
  assert.equal(playerById(s, 'renamed'), s.players[0]);
  assert.equal(playerById(s, 'c0'), undefined);
  assert.equal(playerIndex(s, s.players[0]), 0);
  assert.throws(() => playerIndex(s, { ...s.players[0] }), /outside the match roster/);
  assert.equal(Object.keys(s.players[0]).some(key => /idx|index/i.test(key)), false);
  const gates = [{ id: 'door-2' }, { id: 'door-10' }];
  assert.equal(gateAt({ map: { gates } }, 1), gates[1]);
});
