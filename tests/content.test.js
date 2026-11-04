import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView, joinGame, setInput } from '../shared/simulation.ts';
import { changeSeat } from '../shared/simulation/state.ts';
import { attack } from '../shared/simulation/combat.ts';
import { actorBaseTint, CONTESTANT_IDENTITY_COLORS } from '../public/appearance.js';
import { defaultContent, legacyContent, contentById, CONTENT_ID, LEGACY_CONTENT_ID } from '../shared/simulation/content.ts';
import { collectEquipment, WEAPONS } from '../shared/equipment.ts';
import { KITS, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS } from '../shared/simulation/rules.ts';

function fixture(content) {
  const s = createGame(4217, undefined, content);
  for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.items = []; s.map.traps = [];
  return { s, p: s.players[0] };
}

test('a match is pinned to a content set that names itself', () => {
  const { s } = fixture();
  assert.equal(s.content.id, LEGACY_CONTENT_ID, 'createGame is the legacy mover, so it defaults to the legacy set');
  assert.equal(s.content.durationTicks, 600 * 20);
  assert.equal(defaultContent().id, CONTENT_ID, 'what a live room ships is the default, and it is a different set');
  assert.notEqual(CONTENT_ID, LEGACY_CONTENT_ID);
});

test('shipped content ids return independent deeply frozen retained and current rosters', () => {
  const legacy = contentById('content-1');
  const legacyAgain = contentById('content-1');
  const current = contentById('content-2');
  assert.equal(legacy.id, 'content-1');
  assert.equal(current.id, 'content-2');
  assert.equal(defaultContent().id, 'content-6', 'the shipped default advances without changing legacy content');
  assert.equal(legacyContent().id, 'content-5', 'and the legacy mover keeps the last set it runs');
  // content-3 changes only how bots plan (#424): content-2's numbers and roster, over free-space tiles.
  const { id, navigation, ...tuning } = contentById('content-3'), { id: _, ...previous } = current;
  assert.deepEqual([id, navigation, tuning], ['content-3', 'tiles', previous]);
  assert.equal(current.navigation, undefined, 'content-2 keeps the grid planner');
  // content-4 changes only how a repath runs (#470): content-3, with searches spread over ticks.
  const { id: id4, replanning, ...rest } = contentById('content-4'), { id: _3, ...three } = contentById('content-3');
  assert.deepEqual([id4, replanning, rest], ['content-4', 'sliced', three]);
  // content-5 repairs a contestant's route round nearby changes at once (#470 part 2); otherwise content-4.
  const { id: id5, replanning: replanning5, ...rest5 } = contentById('content-5'), { id: _4, replanning: _r4, ...four } = contentById('content-4');
  assert.deepEqual([id5, replanning5, rest5], ['content-5', 'repair', four]);
  // content-6 is content-physics-8 under a shipped name (#523), the first set built for the physics engine, with two
  // differences real maps need: ground capacity for every live zone size (the lab's 4096 refuses a 36x18 map's 8,608
  // items) and a drop reserve (a real map's items fill the world's body slots, so no drop could be admitted).
  const { id: id6, ...six } = contentById('content-6'), { id: _8, ...physics8 } = contentById('content-physics-8');
  assert.deepEqual([id6, six], ['content-6', { ...physics8, itemInstances: { groundCapacity: 65536 },
    worldPhysics: { ...physics8.worldPhysics, dropReserve: 48 } }]);
  assert.ok(six.actorPhysics && six.hook, 'it carries the character, world and hook physics');
  assert.equal(rest5.actorPhysics, undefined, 'content-5 stays on the legacy mover');
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

test('compatibility exports are detached copies of the shipped tables', () => {
  const shipped = defaultContent();
  assert.deepEqual(WEAPONS, shipped.weapons);
  assert.deepEqual(KITS, shipped.kits);
  assert.deepEqual([DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS], [shipped.durationTicks, shipped.cellChargeTicks, shipped.gladiatorRespawnTicks, shipped.hazardGraceTicks]);
  assert.ok(!Object.isFrozen(WEAPONS.scattergun.spread), 'standalone callers may still edit them');
  const existing = createGame(4217);
  const saved = structuredClone({ WEAPONS, KITS });
  try {
    WEAPONS.pistol.damage = 999; WEAPONS.scattergun.spread.push(1); WEAPONS.scattergun.spread[0] = 5;
    KITS.warden.cooldown = 1; KITS.specter.name = 'Changed';
    for (const id of ['content-1', 'content-2']) {
      const content = contentById(id);
      assert.equal(content.weapons.pistol.damage, 10, id);
      assert.deepEqual(content.weapons.scattergun.spread, [-0.18, -0.09, 0, 0.09, 0.18], id);
      assert.equal(content.kits.warden.cooldown, 110, id);
      assert.equal(content.kits.specter.name, 'Specter', id);
    }
    assert.deepEqual(existing.content.weapons.scattergun.spread, [-0.18, -0.09, 0, 0.09, 0.18], 'nor a match already created');
    assert.equal(createGame(4217).content.kits.warden.cooldown, 110, 'nor one created afterwards');
  } finally {
    for (const [name, table] of Object.entries({ WEAPONS, KITS })) for (const key of Object.keys(table)) table[key] = saved[name][key];
  }
  assert.deepEqual(WEAPONS, shipped.weapons);
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

test('a contestant roster place is recorded and every view carries the frame\'s place (#792)', () => {
  const s = createGame(4217);
  const contestants = s.players.filter(p => p.role === 'contestant');
  const gladiators = s.players.filter(p => p.role === 'gladiator');
  assert.deepEqual(contestants.map(p => p.seat), contestants.map((_, i) => i), 'a place starts at its roster index');
  assert.ok(gladiators.every(p => p.seat === undefined), 'gladiators are told apart by kit, not by a place');

  // The seat belongs to the roster place, not to whoever holds it: a join takes the place with it, and
  // a role change leaves it behind when the place goes back to its bot.
  assert.equal(joinGame(s, 'first', 'contestant', 'warden', 'First').seat, 0);
  const joined = joinGame(s, 'runner', 'contestant', 'warden', 'Runner');
  assert.equal(joined.seat, 1, 'the person in a place inherits its seat');
  const moved = changeSeat(s, 'runner', 'gladiator', 'specter');
  assert.equal(moved.seat, undefined, 'a gladiator place has no seat');
  assert.equal(joined.seat, 1, 'the vacated place keeps its seat as a bot holds it again');
  assert.equal(joinGame(s, 'other', 'contestant', 'warden', 'Other').seat, 1, 'someone else can take the vacated place');
  const back = changeSeat(s, 'runner', 'contestant', 'warden');
  assert.equal(back.seat, 2, 'taking another contestant place takes that place\'s seat');

  // A seat is recorded player state, so a snapshot carries the place its players held at that tick.
  const frame = snapshot(s);
  const recorded = new Map(frame.players.map(p => [p.id, p.seat]));
  for (const p of s.players) assert.equal(recorded.get(p.id), p.seat, `${p.id} records its seat`);
  assert.ok(Object.hasOwn(frame.players.find(p => p.id === 'runner'), 'seat'), 'the snapshot record serializes the seat');
  const directed = new Map(playerView(s, frame, 'spectator').players.map(p => [p.id, p]));
  for (const p of s.players) assert.equal(directed.get(p.id)?.seat, p.seat, `${p.id} carries its recorded seat`);
  assert.equal(playerView(s, frame, 'runner').players.find(p => p.id === 'runner').seat, 2, 'an own record carries it too');
});

test('a delayed spectator view carries the seat of the frame it shows, not the join after it (#792)', () => {
  const s = createGame(4217);
  const before = snapshot(s); // c0 still holds seat 0
  const joined = joinGame(s, 'late', 'contestant', 'warden', 'Late'); // takes seat 0 after the frame
  assert.equal(joined.id, 'late');

  // The delayed frame is projected against the live match, so a live-state lookup would lose c0's seat.
  const delayed = playerView(s, before, 'spectator');
  assert.equal(delayed.players.find(p => p.id === 'c0').seat, 0, 'the old frame keeps its own title holder');
  assert.equal(delayed.players.find(p => p.id === 'late'), undefined, 'the joiner is not in a frame from before the join');
  assert.equal(playerView(s, snapshot(s), 'spectator').players.find(p => p.id === 'late').seat, 0, 'the live view reports the joiner');
});

test('a frame from before schema 16 projects without a seat and keeps the id fallback tint (#792)', () => {
  const s = createGame(4217);
  const old = snapshot(s);
  for (const p of old.players) delete p.seat; // what a recording written before schema 16 looks like
  const view = playerView(s, old, 'spectator');
  assert.ok(view.players.every(p => !Object.hasOwn(p, 'seat')), 'no seat is invented for an older frame');
  const variants = CONTESTANT_IDENTITY_COLORS.length - 1;
  for (const p of view.players.filter(p => p.role === 'contestant')) {
    const place = Number(p.id.slice(1)); // c0..c7 encode the same place the missing seat would give
    assert.equal(actorBaseTint(p, 'me'), CONTESTANT_IDENTITY_COLORS[1 + (place % variants)], `${p.id} keeps its hue`);
  }
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
