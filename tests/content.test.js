import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView, joinGame, setInput } from '../shared/simulation.ts';
import { attack } from '../shared/simulation/combat.ts';
import { defaultContent, contentById, CONTENT_ID } from '../shared/simulation/content.ts';
import { collectEquipment, WEAPONS } from '../shared/equipment.ts';
import { KITS } from '../shared/simulation/rules.ts';

function fixture(content) {
  const s = createGame(4217, undefined, content);
  for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.items = []; s.map.traps = [];
  return { s, p: s.players[0] };
}

test('a match is pinned to a content set that names itself', () => {
  const { s } = fixture();
  assert.equal(s.content.id, CONTENT_ID);
  assert.equal(s.content.durationTicks, 600 * 20);
});

test('shipped content ids return independent deeply frozen retained and current rosters', () => {
  const legacy = contentById('content-1');
  const legacyAgain = contentById('content-1');
  const current = contentById('content-2');
  assert.equal(legacy.id, 'content-1');
  assert.equal(current.id, 'content-2');
  assert.equal(defaultContent().id, 'content-2', 'the shipped default advances without changing legacy content');
  assert.notEqual(legacy, legacyAgain);
  assert.notEqual(legacy.roster, legacyAgain.roster);
  assert.notEqual(legacy.roster, current.roster);
  assert.ok(Object.isFrozen(legacy.roster));
  assert.ok(Object.isFrozen(current.roster));
  assert.ok(Object.isFrozen(legacy.roster.gladiators));
  assert.ok(Object.isFrozen(legacy.roster.gladiators[0]));
  assert.throws(() => { legacy.roster.gladiators.push({ name: 'NOPE', kit: 'warden' }); }, TypeError);
  assert.deepEqual(current.roster.contestants, legacy.roster.contestants);
  assert.deepEqual(current.roster.gladiators.slice(0, 2), legacy.roster.gladiators);
  assert.deepEqual(current.roster.gladiators[2], { name: 'BLAZE', kit: 'striker' });
  assert.throws(() => contentById('missing-content'), RangeError);
});

test('retained content does not read mutable exported default tables', () => {
  const damage = WEAPONS.pistol.damage, cooldown = KITS.warden.cooldown;
  try {
    WEAPONS.pistol.damage = 999;
    KITS.warden.cooldown = 1;
    const legacy = contentById('content-1');
    assert.equal(legacy.weapons.pistol.damage, 10);
    assert.equal(legacy.kits.warden.cooldown, 110);
  } finally {
    WEAPONS.pistol.damage = damage;
    KITS.warden.cooldown = cooldown;
  }
});

test('content-2 defaults to eight contestants and three hunters at the retained transit order', () => {
  const s = createGame(4217);
  const contestants = s.players.filter(p => p.role === 'contestant');
  const hunters = s.players.filter(p => p.role === 'gladiator');
  assert.equal(contestants.length, 8);
  assert.equal(hunters.length, 3);
  assert.deepEqual(s.players.slice(0, 10).map(p => [p.id, p.name, p.role, p.kit]), [
    ['c0', 'Mica', 'contestant', 'warden'], ['c1', 'Juno', 'contestant', 'warden'],
    ['c2', 'Patch', 'contestant', 'warden'], ['c3', 'Pip', 'contestant', 'warden'],
    ['c4', 'Nova', 'contestant', 'warden'], ['c5', 'Rook', 'contestant', 'warden'],
    ['c6', 'Echo', 'contestant', 'warden'], ['c7', 'Sol', 'contestant', 'warden'],
    ['g0', 'IRONCLAD', 'gladiator', 'warden'], ['g1', 'VESPER', 'gladiator', 'specter'],
  ]);
  const blaze = hunters[2];
  assert.deepEqual([blaze.id, blaze.name, blaze.kit], ['g2', 'BLAZE', 'striker']);
  assert.deepEqual([blaze.x, blaze.y], [s.map.stations.at(-3).x, s.map.stations.at(-3).y]);
});

test('the current roster permits all three hunter claims and rejects a fourth', () => {
  const s = createGame(4217);
  const claims = ['warden', 'specter', 'striker'].map((kit, i) => joinGame(s, `hunter-${i}`, 'gladiator', kit, `Hunter ${i}`));
  assert.deepEqual(claims.map(p => p?.id), ['hunter-0', 'hunter-1', 'hunter-2']);
  assert.equal(joinGame(s, 'hunter-3', 'gladiator', 'warden', 'Hunter 3'), null);
});

test('content choice does not change the generated map', () => {
  const legacy = createGame(4217, undefined, contentById('content-1'));
  const current = createGame(4217, undefined, contentById('content-2'));
  assert.deepEqual(current.map, legacy.map);
});

test('two matches hold independent copies', () => {
  const a = createGame(1), b = createGame(1);
  assert.notEqual(a.content, b.content, 'not the same object');
  assert.deepEqual(a.content, b.content, 'but the same values');
  assert.notEqual(a.content.weapons, b.content.weapons, 'tables are copied, not shared');
});

test('a match cannot edit the balance it is running under', () => {
  const { s } = fixture();
  assert.throws(() => { s.content.weapons.pistol.damage = 999; }, TypeError, 'weapon specs are frozen');
  assert.throws(() => { s.content.durationTicks = 1; }, TypeError, 'so are the tick rules');
  assert.throws(() => { s.content.kits.warden.cooldown = 0; }, TypeError, 'and the kit table');
});

test('the simulation reads the pinned content, not the shipped constants', () => {
  // A match given a harder-hitting pistol must hit harder, which is only true if the read goes
  // through the match rather than through the module the defaults live in.
  const content = structuredClone(defaultContent());
  content.id = 'test-content';
  content.weapons.pistol.damage = 90;
  Object.freeze(content);

  const shoot = game => {
    const shooter = game.players[1], target = game.players[2];
    game.map.items = []; game.map.traps = []; game.map.obstacles = []; game.map.gates = [];
    for (const q of game.players) { q.bot = false; q.input = {}; }
    Object.assign(shooter, { x: 6000, y: 6000, heading: 0, attackCd: 0 });
    Object.assign(target, { x: 6080, y: 6000, hp: 100, shield: 0 });
    for (const q of game.players) if (q !== shooter && q !== target) Object.assign(q, { x: 1000, y: 1000 });
    collectEquipment(shooter, { kind: 'weapon', weaponType: 'pistol' }, game.content.weapons);
    shooter.selectedSlot = shooter.inventory.findIndex(i => i?.kind === 'weapon');
    attack(game, shooter);
    for (let i = 0; i < 6; i++) step(game);
    return target.hp;
  };
  const standard = shoot(createGame(4217));
  const harder = shoot(createGame(4217, undefined, content));
  assert.ok(harder < standard, `pinned content decides damage, got ${harder} against ${standard}`);
});

test('content stays out of every frame, and is named once instead', () => {
  const { s } = fixture();
  step(s);
  const frame = snapshot(s);
  assert.equal(Object.hasOwn(frame, 'content'), false, 'a frame does not repeat the tables');
  assert.equal(JSON.stringify(frame).includes(CONTENT_ID), false);
  // Nor does it leak through a player view, which is a projection of the frame.
  const view = playerView(s, frame, s.players[0].id);
  assert.equal(Object.hasOwn(view, 'content'), false);
  // What a view does carry is the values it needs, read from the match's own content.
  assert.equal(view.duration, s.content.durationTicks);
  assert.equal(frame.cellChargeTicks, s.content.cellChargeTicks);
});

test('a kit is validated against the match content rather than the shipped table', () => {
  const content = structuredClone(defaultContent());
  delete content.kits.striker;
  Object.freeze(content);
  const s = createGame(4217, undefined, content);
  const p = joinGame(s, 'human', 'gladiator', 'striker', 'Runner');
  assert.notEqual(p.kit, 'striker', 'a kit this match does not carry is refused');
  assert.ok(Object.hasOwn(content.kits, p.kit), 'and the fallback is one it does');
});

test('the roster is the one place a capacity is stated', () => {
  const content = structuredClone(defaultContent());
  content.id = 'small-roster';
  content.roster.contestants = ['Solo', 'Duo'];
  content.roster.gladiators = [{ name: 'ONE', kit: 'warden' }];
  Object.freeze(content);
  const s = createGame(4217, undefined, content);

  const contestants = s.players.filter(p => p.role === 'contestant');
  const gladiators = s.players.filter(p => p.role === 'gladiator');
  assert.equal(contestants.length, 2, 'spawning counts the roster');
  assert.equal(gladiators.length, 1);
  assert.deepEqual(contestants.map(p => p.name), ['Solo', 'Duo'], 'in the order the roster gave');
  assert.equal(gladiators[0].kit, 'warden', 'with the kit the roster gave it');
  // Identifiers stay derived from position, which the recorded contract depends on.
  assert.deepEqual(contestants.map(p => p.id), ['c0', 'c1']);
  assert.deepEqual(gladiators.map(p => p.id), ['g0']);
});

test('trap balance is read from the match, not from the module it defaults in', () => {
  // A mine set to hit harder must hit harder. Reach, damage and cadence are balance; the arithmetic
  // that makes the trap work is not, and stays in traps.ts.
  const content = structuredClone(defaultContent());
  content.id = 'heavy-mines';
  content.traps.mine.damage = 80;
  Object.freeze(content);

  const detonate = game => {
    game.map.obstacles = []; game.map.items = []; game.map.gates = []; game.map.buildings = [];
    for (const [i, q] of game.players.entries()) { q.bot = false; q.input = {}; q.x = 10000 + i * 700; q.y = 6000; }
    const victim = game.players[0];
    game.map.traps = [{ id: 'trap', kind: 'mine', x: victim.x + 40, y: victim.y, homeX: victim.x + 40, homeY: victim.y, heading: Math.PI, cooldown: 0, offset: 0 }];
    setInput(game, victim.id, { seq: 1, x: 1 });
    step(game);
    return victim.hp;
  };
  const standard = detonate(createGame());
  const heavier = detonate(createGame(4217, undefined, content));
  assert.ok(heavier < standard, `pinned trap content decides damage, got ${heavier} against ${standard}`);
});

test('a match keeps its content across a full tick', () => {
  const { s } = fixture();
  const before = s.content;
  for (let i = 0; i < 30; i++) step(s);
  assert.equal(s.content, before, 'the same pinned object, not re-read per tick');
});
