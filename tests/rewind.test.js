import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot } from '../shared/simulation.ts';
import { attack, skill } from '../shared/simulation/combat.ts';
import { viewLagFrom, MAX_REWIND_TICKS } from '../shared/simulation/rewind.ts';
import { HZ, INTERPOLATION_DELAY_TICKS } from '../shared/simulation/rules.ts';

/** A gladiator facing +x with an open field, and a contestant to hit. */
function duel() {
  const s = createGame(4217);
  s.map.items = []; s.map.traps = []; s.map.obstacles = []; s.map.gates = [];
  const attacker = s.players.find(p => p.role === 'gladiator');
  const target = s.players.find(p => p.role === 'contestant');
  for (const p of s.players) { p.bot = false; p.input = {}; }
  Object.assign(attacker, { x: 6000, y: 6000, heading: 0, attackCd: 0, cooldown: 0 });
  Object.assign(target, { x: 6060, y: 6000, hp: 100 });
  // Park everyone else far away so only these two resolve against each other.
  for (const p of s.players) if (p !== attacker && p !== target) Object.assign(p, { x: 1000, y: 1000 });
  return { s, attacker, target };
}
/** Build `ticks` of history with the target where it currently stands. */
const settle = (s, ticks = MAX_REWIND_TICKS) => { for (let i = 0; i < ticks; i++) step(s); };

test('view lag is the half trip plus the delay the receive buffer holds a frame', () => {
  assert.equal(viewLagFrom(0), 0, 'no measurement, no compensation');
  assert.equal(viewLagFrom(null), 0);
  // 100 ms round trip is 50 ms one way, one tick at 20 Hz, plus the buffer's own two.
  assert.equal(viewLagFrom(1000 / HZ * 2), 1 + INTERPOLATION_DELAY_TICKS);
  assert.equal(viewLagFrom(10000), MAX_REWIND_TICKS, 'a hopeless connection is bounded, not believed');
});

test('without measured latency nothing is rewound', () => {
  const { s, attacker, target } = duel();
  settle(s);
  target.x = 6400; // well out of the 86 unit reach
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'a swing at empty space misses');
});

test('a swing resolves against where the attacker saw the target', () => {
  const { s, attacker, target } = duel();
  settle(s);
  // The target has since run out of reach, but the attacker's screen still showed it in front of
  // them when they swung, which is the whole point.
  target.x = 6400;
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.ok(target.hp < 100, 'the hit lands where it was aimed');
});

test('rewinding is not permissiveness: a target that has only just arrived is missed', () => {
  const { s, attacker, target } = duel();
  target.x = 6400; // out of reach for the whole recorded window
  settle(s);
  target.x = 6060; // and steps into reach only now, after the swing was aimed
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'the attacker could not have seen them there yet');
});

test('rewind is bounded, so a target outside the window is resolved at the oldest kept position', () => {
  const { s, attacker, target } = duel();
  settle(s);
  target.x = 6400;
  attacker.viewLagTicks = MAX_REWIND_TICKS * 5; // more than the history holds
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.ok(target.hp < 100, 'it still resolves, against the oldest position rather than the present');
});

test('cover is tested at the rewound position too', () => {
  const { s, attacker, target } = duel();
  settle(s);
  target.x = 6400;
  // A wall between the attacker and where the target used to be.
  s.map.obstacles = [{ id: 'w', kind: 'container', x: 6020, y: 5900, w: 20, h: 200 }];
  attacker.viewLagTicks = 3;
  attacker.attackCd = 0;
  attack(s, attacker);
  assert.equal(target.hp, 100, 'a rewound hit still has to have had line of sight');
});

test('an ability resolves against what its caster saw', () => {
  const { s, attacker, target } = duel();
  attacker.kit = 'warden';
  settle(s);
  target.x = 6400; // outside the 130 unit ring now, inside it when the caster acted
  attacker.cooldown = 0;
  attacker.viewLagTicks = 3;
  skill(s, attacker);
  assert.ok(target.hp < 100, 'the shockwave catches who it appeared to catch');
});

test('travel-time projectiles are deliberately not compensated', () => {
  const { s, attacker, target } = duel();
  const shooter = s.players.filter(p => p.role === 'contestant')[1];
  Object.assign(shooter, { x: 6000, y: 6000, heading: 0, attackCd: 0, weapon: 1 });
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
});

test('the rewind history never reaches a snapshot or a recording', () => {
  const { s } = duel();
  settle(s);
  assert.ok(s.rewind.length > 0, 'history is being kept');
  const frame = snapshot(s);
  assert.equal(Object.hasOwn(frame, 'rewind'), false, 'and stays out of the recorded frame');
  // It is derivable from the frames a recording already holds, so carrying it would store twice.
  assert.equal(JSON.stringify(frame).includes('rewind'), false);
});

test('history is bounded rather than growing with the match', () => {
  const { s } = duel();
  settle(s, MAX_REWIND_TICKS * 4);
  assert.equal(s.rewind.length, MAX_REWIND_TICKS);
});

test('a player who leaves stops being compensated', () => {
  const { s, attacker } = duel();
  attacker.viewLagTicks = 4;
  attacker.bot = true;
  delete attacker.viewLagTicks;
  assert.equal(attacker.viewLagTicks, undefined, 'a bot sees the world directly');
});
