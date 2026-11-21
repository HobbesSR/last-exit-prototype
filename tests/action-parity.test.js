import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, createGameRecord, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { attack, skill } from '../shared/simulation/combat.ts';
import { planDrop, planAmmoDrop } from '../shared/simulation/loot.ts';
import { phaseThree } from '../shared/simulation/phase-three.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { arena } from './helpers/arena.js';
import { itemId } from './helpers/item-identity.js';

// Retained record/setup and scenario entry points must agree with production action rules (27).
// Each pair uses identical legal placements; no tick, generated map or physical prop is involved.
const map = () => arena({ cols: 10, rows: 6, cellSize: 100,
  spawns: [{ x: 300, y: 300 }, { x: 300, y: 500 }],
  hunterSpawns: [{ x: 360, y: 300 }, { x: 700, y: 300 }, { x: 900, y: 300 }] }).map;
const content = () => ({ ...structuredClone(contentById('content-ammo-1')),
  discovery: false, hearing: { ticks: 80, ranges: { pistol: 1000, rifle: 1000, scattergun: 1000 } },
  roster: { contestants: ['A', 'B'], gladiators: ['specter', 'striker', 'hook'].map(kit => ({ name: kit, kit })) } });

async function pair(t, bothPhysical = false) {
  const actual = await createGame(1240, map(), content());
  t.after(() => disposePhysics(actual));
  const other = bothPhysical ? await createGame(1240, map(), content()) : createGameRecord(1240, map(), content());
  if (bothPhysical) t.after(() => disposePhysics(other));
  for (const s of [other, actual]) for (const p of s.players) {
    p.bot = false; p.heading = 0; p.attackCd = 0; p.cooldown = 0; p.cloak = 0;
    if (p.inventory) { p.inventory.fill(null); p.selectedSlot = 0; p.weapon = 0; }
  }
  assert.deepEqual(actual.players.map(p => [p.id, p.x, p.y]), other.players.map(p => [p.id, p.x, p.y]));
  return [other, actual];
}

const actions = s => ({ serial: s.serial, projectiles: s.projectiles, effects: s.effects,
  players: s.players.map(p => ({ id: p.id, hp: p.hp, shield: p.shield, status: p.status,
    selectedSlot: p.selectedSlot, weapon: p.weapon, inventory: p.inventory, reserves: p.reserves,
    reload: p.reload, attackCd: p.attackCd, cooldown: p.cooldown, cloak: p.cloak,
    revealed: p.revealed, stun: p.stun, boost: p.boost, aggressor: p.aggressor,
    aggressionUntil: p.aggressionUntil, heard: p.heard })) });
const planned = plan => plan && ({ records: plan.records, itemSerial: plan.itemSerial,
  scatterSerial: plan.scatterSerial, identities: plan.allocation.itemIdentities });
const allocationState = s => structuredClone({ itemSerial: s.itemSerial, scatterSerial: s.scatterSerial,
  identities: s.itemIdentities });

// A gladiator's melee has one owner since #1242: phase 5's caster run in the core (`combat.rs`), covered by the frozen
// characterization, tick-phases and the rewind tests. Only the contestant's record-level copy remains here (#1241).
test('record-only attacks match core firearms, utilities and hearing', async t => {
  const games = await pair(t);
  for (const s of games) {
    const p = s.players[0], id = itemId(s, 'carried-pistol');
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 2, quality: 2, instanceId: id, lineageId: id };
    p.cloak = 20;
    attack(s, p);
  }
  assert.deepEqual(actions(games[1]), actions(games[0]));
  assert.equal(games[1].projectiles.length, 1);
  assert.equal(games[1].players[2].heard.length, 1);
  for (const kind of ['med', 'shield']) {
    for (const s of games) {
      const p = s.players[0], id = itemId(s, `carried-${kind}`);
      Object.assign(p, { hp: 90, shield: 70, attackCd: 0 });
      p.inventory[0] = { kind, count: 1, instanceId: id, lineageId: id };
      attack(s, p);
    }
    assert.deepEqual(actions(games[1]), actions(games[0]));
    assert.equal(games[1].players[0].inventory[0], null);
  }
});

test('bare drop planners match core staged records, refusals and mandatory fallback', async t => {
  const games = await pair(t);
  const check = (makePlan, message) => {
    const before = games.map(allocationState);
    assert.deepEqual(planned(makePlan(games[1])), planned(makePlan(games[0])), message);
    games.forEach((s, i) => assert.deepEqual(allocationState(s), before[i], 'planning leaves the live allocator untouched'));
  };
  for (const s of games) itemId(s, 'carried-stack');
  const carried = s => ({ kind: 'med', count: 3, quality: 2,
    instanceId: itemId(s, 'carried-stack'), lineageId: itemId(s, 'carried-stack') });
  check(s => planDrop(s, s.players[1], carried(s)), 'split stacks preserve identity and placement');
  check(s => planAmmoDrop(s, s.players[1], 'pistol', 7), 'ammo uses the same staged allocation');
  check(s => planDrop(s, s.players[1], { kind: 'med', count: 1, quality: NaN }), 'invalid payload is refused');
  // A staged list with an unplaceable coordinate blocks every spiral candidate in both paths.
  for (const s of games) s.items.push({ id: itemId(s, 'unplaceable'), kind: 'med', count: 1, x: NaN, y: 500 });
  check(s => planDrop(s, s.players[1], carried(s), false, [...s.items]), 'optional staged placement refuses');
  check(s => planDrop(s, s.players[1], carried(s), true, [...s.items]), 'mandatory staged placement falls back');
  check(s => planAmmoDrop(s, s.players[1], 'pistol', 7), 'optional ammo placement refuses');
  check(s => planAmmoDrop(s, s.players[1], 'pistol', 7, true), 'mandatory ammo placement falls back');
  assert.equal(planDrop(games[0], games[0].players[1], carried(games[0]), false, [...games[0].items]), null);
  assert.ok(planDrop(games[0], games[0].players[1], carried(games[0]), true, [...games[0].items]).records
    .every(record => record.x === 300 && record.y === 500));
});

test('direct scenario skills match phase three specter, striker and hook launch/cancel', async t => {
  const [direct, core] = await pair(t, true);
  for (const caster of [2, 3, 4, 4]) {
    skill(direct, direct.players[caster]);
    phaseThree(core, core.players.map((_, i) => i === caster ? { input: { skill: true } } : undefined));
    assert.deepEqual(actions(core), actions(direct));
    assert.deepEqual(physicsRuntime(core).hooks, physicsRuntime(direct).hooks);
  }
  assert.ok(core.players[0].revealed > 0, 'specter affects the opposing contestant');
  assert.ok(core.players[3].boost > 0, 'striker activates its boost');
  assert.deepEqual(physicsRuntime(core).hooks, [], 'the second hook press cancels the flight');
});
