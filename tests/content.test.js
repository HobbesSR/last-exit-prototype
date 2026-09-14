import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView, joinGame } from '../shared/simulation.ts';
import { attack } from '../shared/simulation/combat.ts';
import { defaultContent, CONTENT_ID } from '../shared/simulation/content.ts';
import { collectEquipment } from '../shared/equipment.ts';

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

test('a match keeps its content across a full tick', () => {
  const { s } = fixture();
  const before = s.content;
  for (let i = 0; i < 30; i++) step(s);
  assert.equal(s.content, before, 'the same pinned object, not re-read per tick');
});
