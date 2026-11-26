import { renderedPlayerView as playerView } from './helpers/relational.js';
import { itemId } from './helpers/item-identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameRecord, createGame, disposePhysics, joinGame, setInput, stateOf, step, snapshot, visibleTo, couldSee, synchronizePhysics, POTENTIAL, TILE, DURATION, CELL_CHARGE_TICKS } from '../shared/simulation.ts';
import { startGame } from '../shared/simulation/tick.ts';
import { moveBody } from '../shared/movement.ts';
import { lineClear } from '../shared/sight.ts';
import { initCoreSight } from '../shared/sight-core.ts';
import { collectInstanceEquipment, carriedCell } from '../shared/equipment.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena, openField } from './helpers/arena.js';
import { generatedMap } from './helpers/room-harness.js';
import { now, stagePhysics } from './helpers/scenario.js';

// The core rules on the shipped content and its engine (#920). Scenes stand on open ground, people rather than
// bots unless a case says otherwise; cases that need a whole match play the room arena, and cases that never
// step build the game without its physics world. What the street generator alone promised (seeded maps, route
// lengths) went with its stage of #920. That a gap admits contestants and stops gladiators is physics-openings' claim.

const Y = 576;
const door = (id, x, y, extra = {}) => ({ id, x, y, w: 26, h: 54, open: false, locked: false, kind: 'door', ...extra });

/** `actors` on `map` (open ground by default), none of them bots unless asked; dispose with `disposePhysics`. */
async function scene(actors, map = openField(2400).map, content = defaultContent()) {
  const { s, players } = await stagePhysics(map, { content, actors: actors.map(a => ({ bot: false, ...a })) });
  return { s, players };
}
const contestant = (x, y = Y, extra) => ({ role: 'contestant', x, y, ...extra });
const gladiator = (x, y = Y, extra) => ({ role: 'gladiator', x, y, ...extra });
function input(s, p, values) { assert.ok(setInput(s, p.id, { seq: p.lastSeq + 1, ...values })); step(s); }
/** The shipped content on the room arena, without its world: for cases that never step. */
const still = () => createGameRecord(4217, generatedMap(), defaultContent());

test('the committed frame shows a keyed door unlocked and open', async () => {
  const map = openField(2400, { gates: [door('locked', 1200, Y, { locked: true })] }).map;
  const { s, players: [keyless, holder] } = await scene([contestant(1150), contestant(1250)], map);
  try {
    holder.keys = 1;
    input(s, keyless, { interact: true });
    assert.deepEqual(snapshot(s).gates[0], { gateIdx: 0, open: false, locked: true });
    input(s, holder, { interact: true });
    assert.deepEqual(snapshot(s).gates[0], { gateIdx: 0, open: true, locked: false });
    assert.equal(now(s, holder).keys, 0);
  } finally { disposePhysics(s); }
});

test('a seeded match steps to identical complete frames', async () => {
  const [a, b] = await Promise.all([1, 2].map(() => createGame(11, generatedMap(), defaultContent())));
  try {
    for (let i = 0; i < 200; i++) { step(a); step(b); assert.deepEqual(snapshot(a), snapshot(b), `tick ${i}`); }
  } finally { disposePhysics(a); disposePhysics(b); }
});

test('clients cannot send positions or amplify movement and stale inputs are rejected', async () => {
  // A twin given a plain unit input shows how far one tick's movement goes.
  const [{ s, players: [p] }, plain] = await Promise.all([0, 1].map(() => scene([contestant(600), contestant(2000)])));
  try {
    const x = p.x;
    input(plain.s, plain.players[0], { x: 1 });
    input(s, p, { x: 999, y: 0, hp: 9999, keys: 9999, position: { x: 3000 } });
    assert.ok(now(s, p).x > x, 'it moves');
    assert.equal(now(s, p).x, now(plain.s, plain.players[0]).x, 'exactly as far as a unit input');
    assert.equal(now(s, p).hp, now(plain.s, plain.players[0]).hp); assert.equal(now(s, p).keys, 0);
    assert.equal(setInput(s, p.id, { seq: p.lastSeq, x: 1 }), false);
    // A starved queue repeats the movement for a while, then the body comes to rest.
    for (let i = 0; i < 60; i++) step(s);
    const stopped = now(s, p).x; step(s); assert.equal(now(s, p).x, stopped);
    input(s, p, { x: { toString: null, valueOf: null }, y: [999] }); step(s); assert.equal(now(s, p).x, stopped);
  } finally { disposePhysics(s); disposePhysics(plain.s); }
});

test('snapshots are independent copies including bot routes and input acknowledgments', async t => {
  const s = await createGame(4217, generatedMap(), defaultContent());
  t.after(() => disposePhysics(s));
  const human = s.players[0]; human.bot = false; human.input = {};
  const { match } = startGame(s);
  let bot, route;
  // A tile planner's first plans are staggered, and a sliced search may span ticks.
  for (let i = 0; i < 40 && !bot; i++) {
    step(s);
    bot = s.players.find(p => p.bot && match.botRoute(p.id).length);
  }
  assert.ok(bot, 'a bot must hold a route to witness');
  route = match.botRoute(bot.id);
  const expectedRoute = structuredClone(route);
  route[0].x += 99; route.push({ ...route[0] });
  assert.deepEqual(match.botRoute(bot.id), expectedRoute);
  assert.ok(setInput(s, human.id, { seq: human.lastSeq + 1, x: 1, y: 0 }));
  step(s);
  const frame = snapshot(s), mine = frame.players.find(p => p.id === human.id), theirs = frame.players.find(p => p.id === bot.id);
  const frameRoute = structuredClone(theirs.route);
  assert.ok(frameRoute?.length > 0, 'the snapshot carries the bot route');
  assert.deepEqual(frameRoute, match.botRoute(bot.id));
  assert.equal(mine.lastSeq, human.lastSeq);
  assert.ok(mine.lastSeq >= 0);
  const accepted = structuredClone(mine.input), before = JSON.stringify(frame);
  const otherRoute = snapshot(s).players.find(p => p.id === bot.id).route;
  otherRoute[0].x += 99; otherRoute.push({ ...otherRoute[0] });
  assert.deepEqual(match.botRoute(bot.id), frameRoute, 'mutating a private snapshot leaves the core route intact');
  assert.ok(setInput(s, human.id, { seq: human.lastSeq + 1, x: -1, y: 0 }));
  for (let i = 0; i < 20; i++) step(s);
  assert.deepEqual(theirs.route, frameRoute);
  assert.deepEqual(mine.input, accepted);
  assert.equal(JSON.stringify(frame), before);
});

test('joining claims an active bot and refuses a finished match', () => {
  const s = still(); const p = joinGame(s, 'human', 'gladiator', 'striker', 'Guest');
  assert.equal(p.bot, false); assert.equal(p.kit, 'striker');
  s.phase = 'finished'; assert.equal(joinGame(s, 'late'), null);
});

test('directed views are unfogged, player views withhold private fields, and neither carries bookkeeping', async t => {
  const s = await createGame(4217, generatedMap(), defaultContent());
  t.after(() => disposePhysics(s));
  for (let i = 0; i < 40; i++) step(s);
  const frame = snapshot(s);
  const c = s.players.find(p => p.role === 'contestant');
  const mine = playerView(s, frame, c.id), directed = playerView(s, frame, 'presenter-1');
  // A directed view is the one without `self`; neither says which it is, since the client knows how it joined.
  assert.ok(mine.self); assert.equal(Object.hasOwn(directed, 'self'), false);
  for (const view of [mine, directed]) assert.equal(Object.hasOwn(view, 'directed'), false);
  assert.equal(directed.players.length, frame.players.length);
  assert.equal(directed.items.length, frame.items.length);
  assert.ok(mine.items.length < frame.items.length, 'a player view is fogged');
  const self = mine.players.find(p => p.id === c.id);
  for (const field of ['keys', 'kills', 'cooldown', 'lastSeq']) assert.equal(Object.hasOwn(self, field), true, `own ${field} retained`);
  for (const field of ['path', 'input', 'inputTick', 'bot']) assert.equal(Object.hasOwn(self, field), false, `own ${field} withheld`);
  const others = mine.players.filter(p => p.id !== c.id);
  assert.ok(others.length > 0);
  for (const other of others) {
    for (const field of ['x', 'y', 'hp', 'heading', 'status']) assert.equal(Object.hasOwn(other, field), true, `${field} observable`);
    for (const field of ['keys', 'kills', 'level', 'cooldown', 'attackCd', 'railCd', 'boost', 'stun', 'lastSeq', 'bot', 'path', 'input'])
      assert.equal(Object.hasOwn(other, field), false, `${field} withheld from ${other.id}`);
  }
  for (const view of [mine, directed]) for (const field of ['rng', 'serial']) assert.equal(Object.hasOwn(view, field), false, `${field} not broadcast`);
  assert.equal(setInput(s, 'presenter-1', { seq: 1, x: 1 }), false, 'a non-player id has no input authority');
});

test('historical projections use historical player membership and contestant totals', () => {
  const s = still(), p = s.players.find(q => q.role === 'contestant');
  const frame = snapshot(s);
  p.status = 'eliminated'; p.id = 'replacement';
  const view = playerView(s, frame, frame.players[0].id);
  assert.ok(view.self, 'a player view');
  assert.equal(view.contestantsActive, 8);
  assert.equal(playerView(s, frame, null).contestantsActive, 8);
});

test('the server transmits what could become visible while gameplay still turns on true sight', async () => {
  // A contestant close behind solid cover: reachable, but not actually in sight.
  const cover = { id: 'sight-block', x: 660, y: Y - 80, w: 30, h: 160, kind: 'fence' };
  const { s, players: [p, c] } = await scene([gladiator(600), contestant(750)], openField(2400, { obstacles: [cover] }).map);
  try {
    assert.equal(visibleTo(s, p, c), false, 'true sight is blocked by cover');
    assert.equal(couldSee(s, p, c), true, 'but it is close enough to matter next tick');
    synchronizePhysics(s);
    assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), true, 'so it is transmitted');
    // A cloak can drop the instant its owner fires, so cloaked actors are carried too and hidden client side.
    c.cloak = 40;
    assert.equal(visibleTo(s, p, c), false);
    assert.equal(couldSee(s, p, c), true);
    // Beyond the transmit radius nothing is sent at all, cover or no cover.
    c.cloak = 0; c.x = p.x + POTENTIAL + 10;
    assert.equal(couldSee(s, p, c), false);
    synchronizePhysics(s);
    assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), false);
    // A reveal outranks distance entirely, because it makes the target visible to gladiators anywhere.
    c.revealed = 30;
    assert.equal(couldSee(s, p, c), true);
  } finally { disposePhysics(s); }
});

test('each input is spent by exactly one tick, so a press is neither merged away nor repeated', async () => {
  const { s, players: [p] } = await scene([gladiator(600), contestant(2000)]);
  try {
    // Two client messages between two server ticks: the second carries no press, as a real client sends.
    // Coalescing them would have thrown one away; a queue spends each on its own tick instead, which is
    // what lets a client replay the same inputs against the same positions and land where the server did.
    assert.ok(setInput(s, p.id, { seq: 1, skill: true }));
    assert.ok(setInput(s, p.id, { seq: 2, x: 1 }));
    step(s);
    assert.ok(now(s, p).cooldown > 0, 'the first tick spent the press');
    assert.equal(p.lastSeq, 1, 'and acknowledged only the input it actually spent');
    const cooldown = now(s, p).cooldown, x = now(s, p).x;
    step(s);
    assert.equal(p.lastSeq, 2, 'the next tick spends the next input');
    assert.ok(now(s, p).x > x, 'which carried the movement that would have been merged away');
    assert.ok(now(s, p).cooldown < cooldown, 'and the press did not fire a second time');
    // A starved queue repeats movement so a single late packet does not stop the player dead, but it
    // never re-fires a one-shot: losing a packet must not spend a charge the player never asked for.
    const held = now(s, p).cooldown;
    for (let i = 0; i < 3; i++) step(s);
    assert.equal(now(s, p).cooldown, held - 3, 'a repeated input carries no press');
  } finally { disposePhysics(s); }
  const { s: s2, players: [p2] } = await scene([contestant(1160), contestant(300)], openField(2400, { gates: [door('door', 1200, Y)] }).map);
  try {
    assert.ok(setInput(s2, p2.id, { seq: 1, interact: true }));
    assert.ok(setInput(s2, p2.id, { seq: 2, x: 0 }));
    step(s2);
    assert.equal(stateOf(s2).gates[0].open, true, 'the same holds for interact');
  } finally { disposePhysics(s2); }
});

test('live visibility hides distant and cloaked enemies, sensor reveals restore tracking', async () => {
  const wall = { id: 'test-wall', x: 1265, y: Y - 60, w: 25, h: 120, kind: 'fence' };
  const { s, players: [p, c] } = await scene([gladiator(300), contestant(1200)], openField(4000, { obstacles: [wall] }).map);
  try {
    // Out of sight 2000 units off, then in sight at 40.
    p.x = c.x + 2000;
    assert.equal(visibleTo(s, p, c), false);
    synchronizePhysics(s);
    assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), false);
    p.x = c.x - 40; assert.equal(visibleTo(s, p, c), true);
    c.cloak = 10; assert.equal(visibleTo(s, p, c), false);
    c.revealed = 10; assert.equal(visibleTo(s, p, c), true);
    c.cloak = 0; c.revealed = 0; p.x = c.x + 150;
    assert.equal(visibleTo(s, p, c), false, 'the wall between them blocks sight');
  } finally { disposePhysics(s); }
});

test('the vision polygon stops at solid cover', async () => {
  const at = { x: 600, y: Y };
  const { map } = openField(2400, { obstacles: [{ id: 'test-wall', x: at.x + 60, y: at.y - 100, w: 30, h: 200 }] });
  assert.equal(lineClear(map, at, { x: at.x + 150, y: at.y }), false);
  const ray = (await initCoreSight()).visibilityPolygon(map, at).find(v => v.x > at.x && Math.abs(v.y - at.y) < 0.001);
  assert.ok(Math.abs(ray.x - at.x - 60) < 0.01);
});

test('continuous analog movement is normalized', () => {
  const { map } = openField(2400), p = { role: 'contestant', x: 600, y: Y }, start = { ...p };
  moveBody(map, p, { x: 1, y: 1 }, 12, 9); assert.ok(Math.abs(Math.hypot(p.x - start.x, p.y - start.y) - 9) < 0.002);
  assert.notEqual(p.x % TILE, 0);
});
