import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, snapshot, playerView } from '../shared/simulation.js';

test('unlisted internal fields stay out of own, other-player and directed frame projections', () => {
  const game = createGame(9), me = game.players[0];
  me.serverSecret = 'private'; me.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 7, serverSecret: 'private' };
  const frame = snapshot(game); frame.serverSecret = 'private';
  frame.players[1].x = me.x + 40; frame.players[1].y = me.y;
  frame.players[1].serverSecret = 'private';
  frame.items = [{ id: 'item', kind: 'cell', charge: 100, x: me.x, y: me.y, serverSecret: 'private' }];
  frame.traps = [{ id: 'trap', kind: 'spider', x: me.x, y: me.y, targetId: me.id, serverSecret: 'private' }];
  frame.projectiles = [{ id: 1, owner: me.id, x: me.x, y: me.y, dx: 1, dy: 0, life: 3, damage: 2, serverSecret: 'private' }];
  frame.effects = [{ id: 2, x: me.x, y: me.y, kind: 'loot', radius: 10, life: 2, serverSecret: 'private' }];
  frame.events = [{ id: 3, tick: 0, text: 'Visible message', serverSecret: 'private' }];
  frame.gates[0].serverSecret = 'private';
  for (const id of [me.id, frame.players[1].id, null]) {
    const view = playerView(game, frame, id), encoded = JSON.stringify(view);
    assert.equal(encoded.includes('serverSecret'), false); assert.equal(encoded.includes('targetId'), false);
    assert.equal(view.events[0].text, 'Visible message'); assert.equal(view.items[0].charge, 100);
    assert.equal(view.projectiles[0].damage, 2);
  }
  assert.equal(playerView(game, frame, me.id).players[0].inventory[0].ammo, 7);
  assert.equal(frame.players[0].serverSecret, 'private', 'projection does not edit recorded state');
});
