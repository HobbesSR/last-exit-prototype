import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, formatEvent } from '../shared/events.ts';
import { event, participant } from '../shared/simulation/loot.ts';

test('formats every event kind and legacy recordings', () => {
  const actor = { playerIdx: 0, name: 'Mica' }, source = { playerIdx: 1, name: 'Rook' };
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(formatEvent({ kind: 'pod_powered', actor, slotsRemaining: 2 }), 'Mica powered an escape pod. 2 slots remain');
  assert.equal(formatEvent({ kind: 'cell_charged', actor }), 'Mica charged a power cell');
  assert.equal(formatEvent({ kind: 'eliminated', target: actor, source }), 'Mica eliminated by Rook');
  assert.equal(formatEvent({ kind: 'eliminated', target: actor }), 'Mica lost to the arena');
  assert.equal(formatEvent({ kind: 'respawned', actor }, 'unsupported'), 'Mica returned to the hunt');
  assert.equal(formatEvent({ kind: 'match_finished' }), 'Broadcast complete');
  assert.equal(formatEvent({ text: 'Old recording' }), 'Old recording');
  assert.equal(formatEvent({ kind: 'cell_charged', actor: {} }), 'Unknown charged a power cell');
});

test('events retain participant names and serial order after a seat changes', () => {
  const player = { id: 'c0', name: 'Mica' };
  const game = { players: [player], events: [], serial: 12, tick: 8 };
  event(game, { kind: 'cell_charged', actor: participant(game, player) });
  player.name = 'Rook';
  event(game, { kind: 'respawned', actor: participant(game, player) });
  assert.deepEqual(game.events.map(e => [e.id, e.tick, e.actor.playerIdx, e.actor.name]), [[12, 8, 0, 'Mica'], [13, 8, 0, 'Rook']]);
  assert.equal(formatEvent(game.events[0]), 'Mica charged a power cell');
});
