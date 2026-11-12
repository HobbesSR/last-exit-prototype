import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, disposePhysics, step, snapshot, playerView, joinGame, setInput } from '../shared/simulation.ts';
import { changeSeat } from '../shared/simulation/state.ts';
import { attack } from '../shared/simulation/combat.ts';
import { actorBaseTint, CONTESTANT_IDENTITY_COLORS } from '../public/appearance.js';
import { defaultContent, contentById, CONTENT_ID } from '../shared/simulation/content.ts';
import { collectInstanceEquipment, WEAPONS } from '../shared/equipment.ts';
import { KITS, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS } from '../shared/simulation/rules.ts';
import { openField } from './helpers/arena.js';
import { generatedMap } from './helpers/room-harness.js';
import { stagePhysics } from './helpers/scenario.js';

// On the shipped content and the room arena (#920). Cases that never step build the game without its physics
// world; cases that step stage the engine on open ground.
const game = (content = defaultContent()) => createGameRecord(4217, generatedMap(), content);
/** Two idle contestants on open ground, on the engine; dispose of it with `disposePhysics`. */
async function stepped(content = defaultContent()) {
  const { map } = openField(1200);
  const { s, players } = await stagePhysics(map, { content, actors: [{ role: 'contestant', bot: false, x: 300, y: 576 }, { role: 'contestant', bot: false, x: 900, y: 576 }] });
  return { s, p: players[0], players };
}

test('a match is pinned to a content set that names itself', () => {
  const s = game();
  assert.equal(s.content.id, CONTENT_ID, 'what a live room ships is the default');
  assert.equal(s.content.durationTicks, 600 * 20);
});

test('createGameRecord without content takes the shipped set', () => {
  assert.equal(createGameRecord(4217, generatedMap()).content.id, CONTENT_ID);
});

test('shipped content ids return independent deeply frozen copies, and retired ids none', () => {
  const six = contentById('content-6'), sixAgain = contentById('content-6'), current = contentById(CONTENT_ID);
  assert.equal(defaultContent().id, 'content-7');
  // content-6 is the first physics set (#523, #921): narrow character bodies, physical items and props, the hook kit
  // and temporary body detours, stated as fields. Ground capacity covers every live zone size (the lab's 4096 refuses
  // a 36x18 map's 8,608 items) and the drop reserve lets a real map's items fill the body slots.
  assert.deepEqual([six.navigation, six.replanning, six.itemInstances, six.worldPhysics.dropReserve, six.dynamicNavigation, six.kits.hook?.name],
    ['tiles', 'repair', { groundCapacity: 65536 }, 48, true, 'Hook']);
  assert.ok(six.actorPhysics && six.hook, 'it carries the character, world and hook physics');
  assert.notEqual(six, sixAgain);
  assert.notEqual(six.roster, sixAgain.roster);
  assert.notEqual(six.roster, current.roster);
  assert.ok(Object.isFrozen(six.roster));
  assert.ok(Object.isFrozen(six.roster.gladiators));
  assert.ok(Object.isFrozen(six.roster.gladiators[0]));
  assert.throws(() => { six.roster.gladiators.push({ name: 'NOPE', kit: 'warden' }); }, TypeError);
  assert.deepEqual(current.roster, six.roster);
  // The legacy mover's sets are retired (#920); recordings that name them are labelled from presentation.ts.
  for (const id of ['content-1', 'content-5', 'content-equipment-1', 'missing-content']) assert.throws(() => contentById(id), RangeError, id);
});

test('compatibility exports are detached copies of the shipped tables', () => {
  const shipped = defaultContent();
  assert.deepEqual(WEAPONS, shipped.weapons);
  assert.deepEqual(KITS, shipped.kits);
  assert.deepEqual([DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS], [shipped.durationTicks, shipped.cellChargeTicks, shipped.gladiatorRespawnTicks, shipped.hazardGraceTicks]);
  assert.ok(!Object.isFrozen(WEAPONS.scattergun.spread), 'standalone callers may still edit them');
  const existing = game();
  const saved = structuredClone({ WEAPONS, KITS });
  try {
    WEAPONS.pistol.damage = 999; WEAPONS.scattergun.spread.push(1); WEAPONS.scattergun.spread[0] = 5;
    KITS.warden.cooldown = 1; KITS.specter.name = 'Changed';
    for (const id of ['content-6', CONTENT_ID]) {
      const content = contentById(id);
      assert.equal(content.weapons.pistol.damage, 10, id);
      assert.deepEqual(content.weapons.scattergun.spread, [-0.18, -0.09, 0, 0.09, 0.18], id);
      assert.equal(content.kits.warden.cooldown, 110, id);
      assert.equal(content.kits.specter.name, 'Specter', id);
    }
    assert.deepEqual(existing.content.weapons.scattergun.spread, [-0.18, -0.09, 0, 0.09, 0.18], 'nor a match already created');
    assert.equal(game().content.kits.warden.cooldown, 110, 'nor one created afterwards');
  } finally {
    for (const [name, table] of Object.entries({ WEAPONS, KITS })) for (const key of Object.keys(table)) table[key] = saved[name][key];
  }
  assert.deepEqual(WEAPONS, shipped.weapons);
});

test('the shipped content defaults to eight contestants and three hunters, each hunter at its authored start', () => {
  const s = game();
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
  assert.deepEqual([blaze.x, blaze.y], [s.map.hunterSpawns[2].x, s.map.hunterSpawns[2].y]);
});

test('the current roster permits all three hunter claims and rejects a fourth', () => {
  const s = game();
  const claims = ['warden', 'specter', 'striker'].map((kit, i) => joinGame(s, `hunter-${i}`, 'gladiator', kit, `Hunter ${i}`));
  assert.deepEqual(claims.map(p => p?.id), ['hunter-0', 'hunter-1', 'hunter-2']);
  assert.equal(joinGame(s, 'hunter-3', 'gladiator', 'warden', 'Hunter 3'), null);
});

test('two matches hold independent copies', () => {
  const a = game(), b = game();
  assert.notEqual(a.content, b.content, 'not the same object');
  assert.deepEqual(a.content, b.content, 'but the same values');
  assert.notEqual(a.content.weapons, b.content.weapons, 'tables are copied, not shared');
});

test('a match cannot edit the balance it is running under', () => {
  const s = game();
  assert.throws(() => { s.content.weapons.pistol.damage = 999; }, TypeError, 'weapon specs are frozen');
  assert.throws(() => { s.content.durationTicks = 1; }, TypeError, 'so are the tick rules');
  assert.throws(() => { s.content.kits.warden.cooldown = 0; }, TypeError, 'and the kit table');
});

test('the simulation reads the pinned content, not the shipped constants', async () => {
  // A match given a harder-hitting pistol must hit harder, which is only true if the read goes
  // through the match rather than through the module the defaults live in.
  const content = structuredClone(defaultContent());
  content.id = 'test-content';
  content.weapons.pistol.damage = 90;
  Object.freeze(content);

  // A third contestant, out of the way, keeps the match live if the target falls.
  const shoot = async content => {
    const { s, players: [shooter, target] } = await stagePhysics(openField(1200).map, { content,
      actors: [{ role: 'contestant', bot: false, x: 300, y: 576 }, { role: 'contestant', bot: false, x: 380, y: 576 }, { role: 'contestant', bot: false, x: 1000, y: 200 }] });
    try {
      Object.assign(shooter, { heading: 0, attackCd: 0 });
      Object.assign(target, { hp: 100, shield: 0 });
      const ground = { id: 'test-pistol', kind: 'weapon', weaponType: 'pistol', ammo: s.content.weapons.pistol.ammo, x: shooter.x, y: shooter.y };
      s.map.items.push(ground);
      collectInstanceEquipment(s, shooter, { ...ground }, ground);
      shooter.selectedSlot = shooter.inventory.findIndex(i => i?.kind === 'weapon');
      attack(s, shooter);
      for (let i = 0; i < 6; i++) step(s);
      return target.hp;
    } finally { disposePhysics(s); }
  };
  const standard = await shoot(defaultContent());
  const harder = await shoot(content);
  assert.ok(harder < standard, `pinned content decides damage, got ${harder} against ${standard}`);
});

test('content stays out of every frame, and is named once instead', async t => {
  const { s } = await stepped();
  t.after(() => disposePhysics(s));
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
  const s = game(content);
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
  const s = game(content);

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
  const s = game();
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
  const s = game();
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
  const s = game();
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

test('trap balance is read from the match, not from the module it defaults in', async () => {
  // A mine set to hit harder must hit harder. Reach, damage and cadence are balance; the arithmetic
  // that makes the trap work is not, and stays in traps.ts.
  const content = structuredClone(defaultContent());
  content.id = 'heavy-mines';
  content.traps.mine.damage = 80;
  Object.freeze(content);

  // A second contestant, out of the mine's reach, keeps the match live if the victim falls.
  const detonate = async content => {
    const { s, players: [victim] } = await stepped(content);
    try {
      s.map.traps = [{ id: 'trap', kind: 'mine', x: victim.x + 40, y: victim.y, homeX: victim.x + 40, homeY: victim.y, heading: Math.PI, cooldown: 0, offset: 0 }];
      setInput(s, victim.id, { seq: 1, x: 1 });
      step(s);
      return victim.hp;
    } finally { disposePhysics(s); }
  };
  const standard = await detonate(defaultContent());
  const heavier = await detonate(content);
  assert.ok(heavier < standard, `pinned trap content decides damage, got ${heavier} against ${standard}`);
});

test('a match keeps its content across a full tick', async t => {
  const { s } = await stepped();
  t.after(() => disposePhysics(s));
  const before = s.content;
  for (let i = 0; i < 30; i++) step(s);
  assert.equal(s.content, before, 'the same pinned object, not re-read per tick');
});
