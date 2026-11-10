import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsGame, disposePhysics, step, snapshot } from '../shared/simulation.ts';
import { attack, skill } from '../shared/simulation/combat.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { viewLagFrom, MAX_REWIND_TICKS } from '../shared/simulation/rewind.ts';
import { HZ, INTERPOLATION_DELAY_TICKS } from '../shared/simulation/rules.ts';
import { createPhysicsMatch } from '../server/match.js';
import { openField } from './helpers/arena.js';

// On the shipped content and its engine (#920). A gladiator facing +x on open ground, a contestant in reach
// to hit, and a second contestant to the south; `away` is out of the 86 unit reach. The engine pins the map
// at creation, so the case that needs a wall builds it into its own map.
const y = 576, away = 1000;
function parts(obstacles = []) {
  const { map } = openField(2000, { obstacles });
  map.spawns = [{ x: 660, y }, { x: 600, y: 760 }]; map.hunterSpawns = [{ x: 600, y }];
  return { map, content: { ...defaultContent(), roster: { contestants: ['C0', 'C1'], gladiators: [{ name: 'G0', kit: 'warden' }] } } };
}
function seat(s) {
  const attacker = s.players.find(p => p.role === 'gladiator');
  const [target, shooter] = s.players.filter(p => p.role === 'contestant');
  for (const p of s.players) { p.bot = false; p.input = {}; }
  Object.assign(attacker, { heading: 0, attackCd: 0, cooldown: 0 });
  return { s, attacker, target, shooter };
}
/** A case on the duel, disposed of after it; `obstacles` are built into its map. */
const duel = (body, obstacles) => async () => {
  const { map, content } = parts(obstacles), s = await createPhysicsGame(4217, map, content);
  try { await body(seat(s)); } finally { disposePhysics(s); }
};
/** Build `ticks` of history with the target where it currently stands. */
const settle = (s, ticks = MAX_REWIND_TICKS) => { for (let i = 0; i < ticks; i++) step(s); };

test('view lag is the half trip plus the delay the receive buffer holds a frame', () => {
  assert.equal(viewLagFrom(0), 0, 'no measurement, no compensation');
  assert.equal(viewLagFrom(null), 0);
  // 100 ms round trip is 50 ms one way, one tick at 20 Hz, plus the buffer's own two.
  assert.equal(viewLagFrom(1000 / HZ * 2), 1 + INTERPOLATION_DELAY_TICKS);
  assert.equal(viewLagFrom(10000), MAX_REWIND_TICKS, 'a hopeless connection is bounded, not believed');
});

test('without measured latency nothing is rewound', duel(({ s, attacker, target }) => {
  settle(s);
  target.x = away;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'a swing at empty space misses');
}));

test('a swing resolves against where the attacker saw the target', duel(({ s, attacker, target }) => {
  settle(s);
  // The target has since run out of reach, but the attacker's screen still showed it in front of
  // them when they swung, which is the whole point.
  target.x = away;
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.ok(target.hp < 100, 'the hit lands where it was aimed');
}));

test('rewinding is not permissiveness: a target that has only just arrived is missed', duel(({ s, attacker, target }) => {
  const near = target.x;
  target.x = away; // out of reach for the whole recorded window
  settle(s);
  target.x = near; // and steps into reach only now, after the swing was aimed
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'the attacker could not have seen them there yet');
}));

test('rewind is bounded, so a target outside the window is resolved at the oldest kept position', duel(({ s, attacker, target }) => {
  settle(s);
  target.x = away;
  attacker.viewLagTicks = MAX_REWIND_TICKS * 5; // more than the history holds
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.ok(target.hp < 100, 'it still resolves, against the oldest position rather than the present');
}));

// A wall between the attacker and where the target used to be.
test('cover is tested at the rewound position too', duel(({ s, attacker, target }) => {
  settle(s);
  target.x = away;
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'a rewound hit still has to have had line of sight');
}, [{ id: 'w', kind: 'container', x: 628, y: y - 100, w: 8, h: 200 }]));

test('an ability resolves against what its caster saw', duel(({ s, attacker, target }) => {
  attacker.kit = 'warden';
  settle(s);
  target.x = away; // outside the 130 unit ring now, inside it when the caster acted
  attacker.cooldown = 0;
  attacker.viewLagTicks = 3;
  skill(s, attacker);
  assert.ok(target.hp < 100, 'the shockwave catches who it appeared to catch');
}));

test('travel-time projectiles are deliberately not compensated', duel(({ s, shooter }) => {
  Object.assign(shooter, { heading: 0, attackCd: 0, weapon: 1 });
  shooter.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 7 }, null, null, null, null, null];
  shooter.selectedSlot = 0;
  settle(s);
  shooter.viewLagTicks = 5;
  shooter.attackCd = 0;
  attack(s, shooter);
  // A projectile is aimed where the target will be, not where it was: the player already leads it.
  // Rewinding one as well would compensate twice and land shots behind a moving target.
  assert.ok(s.projectiles.length > 0, 'the shot exists');
  assert.equal(s.projectiles[0].x, shooter.x, 'and leaves the shooter, uncompensated');
  assert.equal(s.projectiles[0].y, shooter.y);
}));

test('the rewind history never reaches a snapshot or a recording', duel(({ s }) => {
  settle(s);
  assert.ok(s.rewind.length > 0, 'history is being kept');
  const frame = snapshot(s);
  assert.equal(Object.hasOwn(frame, 'rewind'), false, 'and stays out of the recorded frame');
  // It is derivable from the frames a recording already holds, so carrying it would store twice.
  assert.equal(JSON.stringify(frame).includes('rewind'), false);
}));

test('history is bounded rather than growing with the match', duel(({ s }) => {
  settle(s, MAX_REWIND_TICKS * 4);
  assert.equal(s.rewind.length, MAX_REWIND_TICKS);
}));

test('a player who leaves stops being compensated', async () => {
  // Through the match's own leave, which is what the room calls on a disconnect.
  const { map, content } = parts(), match = await createPhysicsMatch(4217, undefined, map, content);
  try {
    const { s, attacker, target } = seat(match.diagnosticState);
    settle(s);
    target.x = away;
    assert.ok(match.setViewLag(attacker.id, 1000 / HZ * 2));
    assert.ok(attacker.viewLagTicks > 0, 'compensated while connected');
    attacker.attackCd = 0;
    attack(s, attacker);
    assert.ok(target.hp < 100, 'so a swing at where the target was lands');

    target.hp = 100;
    assert.equal(match.leave(attacker.id), true);
    assert.equal(attacker.bot, true);
    assert.equal(Object.hasOwn(attacker, 'viewLagTicks'), false, 'a bot sees the world directly');
    assert.equal(Object.hasOwn(match.snapshot().players.find(p => p.id === attacker.id), 'viewLagTicks'), false);
    attacker.attackCd = 0;
    attack(s, attacker);
    assert.equal(target.hp, 100, 'and the same swing now resolves against the present');
  } finally { match.dispose(); }
});
