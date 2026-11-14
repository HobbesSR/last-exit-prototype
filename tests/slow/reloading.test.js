import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { generatedMap } from '../helpers/room-harness.js';
import { rounds } from '../helpers/rounds.js';

// Moved from tests/reloading.test.js (#1071): a whole bot match is slow-tier work (31). The fast file
// keeps the scripted reload, conservation and recording cases.
test('bots reload from their reserves, and a whole bot match conserves every round it does not fire', async t => {
  const s = await createGame(17, generatedMap(9), contentById('content-ammo-1'));
  t.after(() => disposePhysics(s));
  const contestants = new Set(s.players.filter(p => p.role === 'contestant').map(p => p.id));
  // One attack spends one round however many pellets it fires, so count shooter-ticks.
  const shots = new Set();
  class Counted extends Array { push(...items) { for (const b of items) if (contestants.has(b.owner)) shots.add(`${b.owner}@${s.tick}`); return super.push(...items); } }
  s.projectiles = Counted.from(s.projectiles);
  const total = () => ['pistol', 'rifle', 'shell'].reduce((n, family) => n + rounds(s, family), 0);
  const start = total();
  let reloads = 0;
  for (let i = 0; i < 1500 && s.phase === 'live'; i++) {
    step(s);
    for (const p of s.players) if (p.reload && p.reload.until - s.tick === s.content.reloading.weapons[p.inventory[p.reload.slot].weaponType].reloadTicks) reloads++;
  }
  assert.ok(reloads > 0, 'some bot reloaded');
  assert.ok(shots.size > 0, 'bots fired');
  assert.equal(total(), start - shots.size);
});
