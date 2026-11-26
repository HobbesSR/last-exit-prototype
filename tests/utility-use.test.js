import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { arena } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';
import { identifyItems } from './helpers/item-identity.js';

// What a bot uses is planned by the core, whose utility rules own the effect and its cap (27.2 "Core bot intent"):
// the bot commits a use only when it applies and its cooldown allows.

test('a bot commits a utility use only when it applies and its cooldown allows', async t => {
  for (const [hp, maxHp, attackCd, applies] of [[40, 50, 0, true], [40, 50, 5, false], [40, 40, 0, false]]) {
    const { map } = arena({ cols: 4, rows: 3 });
    const { s, players: [bot] } = await stagePhysics(map, { actors: [{ role: 'contestant', x: 200, y: 200 }, { role: 'contestant', bot: false, x: 500, y: 200 }] });
    t.after(() => disposePhysics(s));
    Object.assign(bot, { hp, maxHp, attackCd, selectedSlot: 4 });
    bot.inventory = [{ kind: 'med', count: 1, instanceId: 'med', lineageId: 'med' }, null, null, null, null, null];
    identifyItems(s);
    const { match } = startGame(s), actor = match.ids.actorOfPlayer.get(bot.id);
    const { input } = stepGame(s).inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor).command;
    assert.equal(input.utilitySlot, applies ? 0 : null, `hp ${hp}/${maxHp}, cooldown ${attackCd}`);
  }
});
