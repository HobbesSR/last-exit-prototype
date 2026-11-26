import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { arena } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';
import { identifyItems } from './helpers/item-identity.js';

// A bot's intent is a committed command (27.2 "Core bot intent"): the core plans it from the last completed tick and
// the tick applies it, so what an intent holds is read from the command row the tick took.

test('a bot walking to a cell with a full inventory commits the slot to discard', async t => {
  const { map } = arena({ cols: 4, rows: 3, items: [{ id: 'wanted-cell', kind: 'cell', x: 400, y: 200, charge: 0 }] });
  const { s, players: [bot] } = await stagePhysics(map, { actors: [{ role: 'contestant', x: 200, y: 200 }, { role: 'contestant', bot: false, x: 700, y: 500 }] });
  t.after(() => disposePhysics(s));
  const held = (n, item) => ({ ...item, instanceId: `held-${n}`, lineageId: `held-${n}` });
  bot.inventory = [
    held(0, { kind: 'weapon', weaponType: 'pistol', ammo: 4 }),
    held(1, { kind: 'shield', count: 2 }),
    held(2, { kind: 'weapon', weaponType: 'rifle', ammo: 1 }),
    held(3, { kind: 'weapon', weaponType: 'scattergun', ammo: 1 }),
    held(4, { kind: 'weapon', weaponType: 'pistol', ammo: 0 }),
    held(5, { kind: 'med', count: 2 }),
  ];
  bot.shield = 75;
  bot.hp = 100;
  identifyItems(s);
  const { match } = startGame(s), actor = match.ids.actorOfPlayer.get(bot.id);
  // The cell is seen from the first tick, so the bot sets out for it and its first command already discards slot 1.
  const { input } = stepGame(s).inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor).command;
  assert.deepEqual(input.drop, { kind: 'slot', slot: 1 });
  assert.ok(input.movement[0] > 0.9, 'toward the cell');
});
