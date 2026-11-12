import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, joinGame, setInput, step, snapshot, visibleTo, couldSee, playerView, POTENTIAL, TILE, DURATION, CELL_CHARGE_TICKS } from '../shared/simulation.ts';
import { movePlayer, lineClear, visibilityPolygon } from '../shared/movement.ts';
import { collectInstanceEquipment, carriedCell } from '../shared/equipment.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { arena, openField } from './helpers/arena.js';
import { generatedMap } from './helpers/room-harness.js';
import { stagePhysics } from './helpers/scenario.js';

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
const still = () => createGame(4217, generatedMap(), defaultContent());

test('a seeded match steps to identical complete frames', async () => {
  const [a, b] = await Promise.all([1, 2].map(() => createPhysicsGame(11, generatedMap(), defaultContent())));
  try {
    for (let i = 0; i < 200; i++) { step(a); step(b); assert.deepEqual(snapshot(a), snapshot(b), `tick ${i}`); }
  } finally { disposePhysics(a); disposePhysics(b); }
});

test('the wall reaches the end of the map at ten minutes', async t => {
  const s = await createPhysicsGame(4217, generatedMap(), defaultContent());
  t.after(() => disposePhysics(s));
  for (const p of s.players) p.bot = false;
  s.tick = DURATION - 1;
  step(s);
  assert.ok(s.hazardX >= s.map.width); assert.equal(s.phase, 'finished');
});

test('clients cannot send positions or amplify movement and stale inputs are rejected', async () => {
  // A twin given a plain unit input shows how far one tick's movement goes.
  const [{ s, players: [p] }, plain] = await Promise.all([0, 1].map(() => scene([contestant(600), contestant(2000)])));
  try {
    const x = p.x;
    input(plain.s, plain.players[0], { x: 1 });
    input(s, p, { x: 999, y: 0, hp: 9999, keys: 9999, position: { x: 3000 } });
    assert.ok(p.x > x, 'it moves');
    assert.equal(p.x, plain.players[0].x, 'exactly as far as a unit input');
    assert.equal(p.hp, plain.players[0].hp); assert.equal(p.keys, 0);
    assert.equal(setInput(s, p.id, { seq: p.lastSeq, x: 1 }), false);
    // A starved queue repeats the movement for a while, then the body comes to rest.
    for (let i = 0; i < 60; i++) step(s);
    const stopped = p.x; step(s); assert.equal(p.x, stopped);
    input(s, p, { x: { toString: null, valueOf: null }, y: [999] }); step(s); assert.equal(p.x, stopped);
  } finally { disposePhysics(s); disposePhysics(plain.s); }
});

test('locked building doors require a key and stay unlocked', async () => {
  // A wall across the field with a locked door in it; the contestant stands beside the door.
  const wall = [{ id: 'north', x: 1187, y: 0, w: 26, h: Y - 27 }, { id: 'south', x: 1187, y: Y + 27, w: 26, h: 1152 - Y - 27 }];
  const { s, players: [p] } = await scene([contestant(1150), contestant(300)], openField(2400, { obstacles: wall, gates: [door('locked', 1200, Y, { locked: true })] }).map);
  try {
    const g = s.map.gates[0];
    input(s, p, { interact: true }); assert.equal(g.open, false);
    p.keys = 1; input(s, p, { interact: true }); assert.equal(g.open, true); assert.equal(p.keys, 0);
    input(s, p, { interact: true }); assert.equal(p.keys, 0);
    assert.equal(g.locked, false, 'unlocking is permanent');
  } finally { disposePhysics(s); }
});

test('only three contestants can extract, and gladiators cannot consume exits', async () => {
  // Four contestants in a ring round the exit, within reach of it, and a gladiator on it.
  const exit = { x: 1800, y: Y };
  const ring = [0, 1, 2, 3].map(i => contestant(exit.x + Math.cos(i * Math.PI / 2) * 40, exit.y + Math.sin(i * Math.PI / 2) * 40));
  const { s, players } = await scene([gladiator(exit.x + 120), ...ring], openField(2400, { exit }).map);
  try {
    const [g, ...contestants] = players;
    Object.assign(g, exit); input(s, g, { interact: true }); assert.equal(s.slots, 3);
    for (const c of contestants) { c.inventory = [{ kind: 'cell', charge: CELL_CHARGE_TICKS }, null, null, null]; setInput(s, c.id, { seq: c.lastSeq + 1, interact: true }); }
    step(s);
    assert.equal(s.slots, 0); assert.equal(s.players.filter(p => p.status === 'escaped').length, 3);
    assert.equal(s.phase, 'finished');
  } finally { disposePhysics(s); }
});

test('power-cell objective requires pickup, stationary charging, and delivery; movement pauses progress', async () => {
  const exit = { x: 2200, y: Y }, charger = { id: 'charger', x: 1200, y: Y }, cell = { id: 'cell', kind: 'cell', x: 600, y: 300 };
  const { s, players: [p] } = await scene([contestant(2160), contestant(300, 1000)], openField(2400, { exit, chargers: [charger], items: [cell] }).map);
  try {
    input(s, p, { interact: true }); assert.equal(s.slots, 3, 'no cell, no extraction');
    Object.assign(p, { x: cell.x, y: cell.y }); input(s, p, {});
    assert.equal(carriedCell(p)?.charge, 0); assert.ok(!s.map.items.some(i => i.id === 'cell'), 'picked up');
    Object.assign(p, { x: exit.x - 40, y: exit.y }); input(s, p, { interact: true }); assert.equal(s.slots, 3, 'an uncharged cell does not extract');
    Object.assign(p, { x: charger.x, y: charger.y + 40 });
    input(s, p, { interact: true }); assert.equal(carriedCell(p).charge, 1);
    input(s, p, { x: 1 }); assert.equal(carriedCell(p).charge, 1); assert.equal(p.charging, null);
    // Stop, so a starved queue does not repeat the step, and come back to the charger.
    input(s, p, {}); Object.assign(p, { x: charger.x, y: charger.y + 40 }); input(s, p, {});
    input(s, p, { interact: true });
    for (let i = carriedCell(p).charge; i < CELL_CHARGE_TICKS; i++) step(s);
    assert.equal(carriedCell(p).charge, CELL_CHARGE_TICKS); assert.equal(p.charging, null);
    Object.assign(p, { x: exit.x - 40, y: exit.y }); input(s, p, { interact: true });
    assert.equal(p.status, 'escaped'); assert.equal(carriedCell(p), null); assert.equal(s.slots, 2);
  } finally { disposePhysics(s); }
});

test('cells take individual slots and retain charge when dropped on death', async () => {
  const at = { x: 600, y: Y };
  const { s, players: [p, , hunter] } = await scene([contestant(at.x), contestant(300, 1000), gladiator(at.x + 40)],
    openField(2400, { items: [{ id: 'a', kind: 'cell', x: at.x, y: at.y - 10 }, { id: 'b', kind: 'cell', x: at.x, y: at.y + 10 }] }).map);
  try {
    // Every slot but one full, however many slots the content gives.
    p.inventory = p.inventory.map((_, i, slots) => i < slots.length - 1 ? { kind: 'weapon', weaponType: 'pistol', instanceId: `w${i}` } : null);
    // The engine collects on a tick that spends an input.
    input(s, p, {}); assert.equal(s.map.items.filter(i => i.kind === 'cell').length, 1, 'one free slot takes one cell');
    carriedCell(p).charge = 55;
    p.hp = 1; p.shield = 0;
    input(s, hunter, { attack: true, aim: Math.PI });
    assert.equal(p.status, 'eliminated'); assert.equal(carriedCell(p), null);
    assert.ok(s.map.items.some(i => i.kind === 'cell' && i.charge === 55));
  } finally { disposePhysics(s); }
});

test('gladiator kills upgrade the kit and refill ability, contestants can damage other contestants', async () => {
  const { s, players: [target, a, b, p] } = await scene([contestant(600), contestant(1500), contestant(1524), gladiator(640)]);
  try {
    target.hp = 1; target.shield = 0; p.cooldown = 80;
    input(s, p, { attack: true, aim: Math.PI });
    assert.equal(target.status, 'eliminated'); assert.equal(p.kills, 1); assert.equal(p.level, 2); assert.equal(p.cooldown, 0);
    const ground = { id: 'test-pistol', kind: 'weapon', weaponType: 'pistol', ammo: s.content.weapons.pistol.ammo, x: a.x, y: a.y };
    s.map.items.push(ground);
    collectInstanceEquipment(s, a, { ...ground }, ground); a.selectedSlot = a.inventory.findIndex(i => i?.kind === 'weapon');
    const hp = b.hp;
    input(s, a, { attack: true, aim: 0 }); assert.equal(b.hp, hp - s.content.weapons.pistol.damage);
  } finally { disposePhysics(s); }
});

test('rail travel is gladiator-only, has a cooldown, and skips stations not past hazardX + TILE', async () => {
  const stations = () => [400, 1400, 2400, 3400].map((x, i) => ({ id: `st${i}`, nodeId: `n${i}`, x, y: Y }));
  const field = () => openField(3600, { stations: stations() }).map;
  const { s, players: [p, c] } = await scene([gladiator(400), contestant(400, Y + 300)], field());
  try {
    const [first, second] = s.map.stations;
    input(s, p, { interact: true }); assert.equal(Math.round(p.x), second.x); assert.equal(p.railCd, 180);
    input(s, p, { interact: true }); assert.equal(Math.round(p.x), second.x);
    Object.assign(c, { x: first.x, y: first.y });
    input(s, c, { interact: true }); assert.equal(Math.round(c.x), first.x);
  } finally { disposePhysics(s); }

  // Advance the hazard so the next station sits behind its edge; travel must pass over it.
  const late = await scene([gladiator(400), contestant(3400, Y + 300)], field());
  try {
    const [, behind, ahead] = late.s.map.stations, { content } = late.s, [g] = late.players;
    late.s.tick = Math.ceil(content.hazardGraceTicks + (behind.x + 80) / (late.s.map.width + 100) * (content.durationTicks - content.hazardGraceTicks)) - 1;
    input(late.s, g, { interact: true });
    assert.ok(behind.x <= late.s.hazardX + TILE && ahead.x > late.s.hazardX + TILE, `hazard ${late.s.hazardX} must fall between ${behind.x} and ${ahead.x}`);
    assert.deepEqual({ x: Math.round(g.x), y: Math.round(g.y) }, { x: ahead.x, y: ahead.y });
  } finally { disposePhysics(late.s); }
});

test('sneaking avoids sensors, contestants have no innate skill, hazard affects gladiators too', async () => {
  const { s, players: [p, g] } = await scene([contestant(1200), gladiator(300)], openField(2400, { sensors: [{ id: 'sensor', x: 1200, y: Y - 40 }] }).map);
  try {
    input(s, p, { sneak: true }); assert.equal(p.revealed, 0);
    input(s, p, {}); assert.ok(p.revealed > 0);
    input(s, p, { skill: true }); assert.equal(p.cooldown, 0); assert.equal(p.cloak, 0);
    s.tick = DURATION - 11;
    const hp = g.hp;
    step(s); assert.ok(g.hp < hp);
  } finally { disposePhysics(s); }
});

test('snapshots are independent copies including bot routes and accepted input', async t => {
  const field = 'route', s = await createPhysicsGame(4217, generatedMap(), defaultContent());
  t.after(() => disposePhysics(s));
  const human = s.players[0]; human.bot = false; human.input = {};
  // A tile planner's first plans are staggered across its bots' turns, and a sliced one's may span ticks.
  for (let i = 0; i < 40 && !s.players.some(p => p.bot && p[field]?.length); i++) step(s);
  assert.ok(setInput(s, human.id, { seq: human.lastSeq + 1, x: 1, y: 0 }));
  step(s);
  const bot = s.players.find(p => p.bot && p[field]?.length);
  assert.ok(bot, `a bot must hold a ${field} to witness`);
  const frame = snapshot(s), mine = frame.players.find(p => p.id === human.id), theirs = frame.players.find(p => p.id === bot.id);
  assert.deepEqual(theirs[field], bot[field]); assert.ok(theirs[field].length > 0);
  assert.deepEqual(mine.input, human.input); assert.equal(mine.input.x, 1); assert.equal(mine.lastSeq, human.lastSeq);
  const route = structuredClone(theirs[field]), accepted = structuredClone(mine.input), before = JSON.stringify(frame);
  bot.route[0].x += 99; bot.route.push({ ...bot.route[0] });
  human.input.x = -1;
  for (let i = 0; i < 20; i++) step(s);
  assert.deepEqual(theirs[field], route); assert.deepEqual(mine.input, accepted);
  assert.equal(JSON.stringify(frame), before);
});

test('joining claims an active bot and refuses a finished match', () => {
  const s = still(); const p = joinGame(s, 'human', 'gladiator', 'striker', 'Guest');
  assert.equal(p.bot, false); assert.equal(p.kit, 'striker');
  s.phase = 'finished'; assert.equal(joinGame(s, 'late'), null);
});

test('directed views are unfogged, player views withhold private fields, and neither carries bookkeeping', async t => {
  const s = await createPhysicsGame(4217, generatedMap(), defaultContent());
  t.after(() => disposePhysics(s));
  for (let i = 0; i < 40; i++) step(s);
  const frame = snapshot(s);
  const c = s.players.find(p => p.role === 'contestant');
  const mine = playerView(s, frame, c.id), directed = playerView(s, frame, 'presenter-1');
  assert.equal(mine.directed, false); assert.equal(directed.directed, true);
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
  assert.equal(view.directed, false);
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
    assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), true, 'so it is transmitted');
    // A cloak can drop the instant its owner fires, so cloaked actors are carried too and hidden client side.
    c.cloak = 40;
    assert.equal(visibleTo(s, p, c), false);
    assert.equal(couldSee(s, p, c), true);
    // Beyond the transmit radius nothing is sent at all, cover or no cover.
    c.cloak = 0; c.x = p.x + POTENTIAL + 10;
    assert.equal(couldSee(s, p, c), false);
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
    assert.ok(p.cooldown > 0, 'the first tick spent the press');
    assert.equal(p.lastSeq, 1, 'and acknowledged only the input it actually spent');
    const cooldown = p.cooldown, x = p.x;
    step(s);
    assert.equal(p.lastSeq, 2, 'the next tick spends the next input');
    assert.ok(p.x > x, 'which carried the movement that would have been merged away');
    assert.ok(p.cooldown < cooldown, 'and the press did not fire a second time');
    // A starved queue repeats movement so a single late packet does not stop the player dead, but it
    // never re-fires a one-shot: losing a packet must not spend a charge the player never asked for.
    const held = p.cooldown;
    for (let i = 0; i < 3; i++) step(s);
    assert.equal(p.cooldown, held - 3, 'a repeated input carries no press');
  } finally { disposePhysics(s); }
  const { s: s2, players: [p2] } = await scene([contestant(1160), contestant(300)], openField(2400, { gates: [door('door', 1200, Y)] }).map);
  try {
    assert.ok(setInput(s2, p2.id, { seq: 1, interact: true }));
    assert.ok(setInput(s2, p2.id, { seq: 2, x: 0 }));
    step(s2);
    assert.equal(s2.map.gates[0].open, true, 'the same holds for interact');
  } finally { disposePhysics(s2); }
});

test('live visibility hides distant and cloaked enemies, sensor reveals restore tracking', async () => {
  const wall = { id: 'test-wall', x: 1265, y: Y - 60, w: 25, h: 120, kind: 'fence' };
  const { s, players: [p, c] } = await scene([gladiator(300), contestant(1200)], openField(4000, { obstacles: [wall] }).map);
  try {
    // Out of sight 2000 units off, then in sight at 40.
    p.x = c.x + 2000;
    assert.equal(visibleTo(s, p, c), false);
    assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), false);
    p.x = c.x - 40; assert.equal(visibleTo(s, p, c), true);
    c.cloak = 10; assert.equal(visibleTo(s, p, c), false);
    c.revealed = 10; assert.equal(visibleTo(s, p, c), true);
    c.cloak = 0; c.revealed = 0; p.x = c.x + 150;
    assert.equal(visibleTo(s, p, c), false, 'the wall between them blocks sight');
  } finally { disposePhysics(s); }
});

test('the vision polygon stops at solid cover', () => {
  const at = { x: 600, y: Y };
  const { map } = openField(2400, { obstacles: [{ id: 'test-wall', x: at.x + 60, y: at.y - 100, w: 30, h: 200 }] });
  assert.equal(lineClear(map, at, { x: at.x + 150, y: at.y }), false);
  const ray = visibilityPolygon(map, at).find(v => v.x > at.x && Math.abs(v.y - at.y) < 0.001);
  assert.ok(Math.abs(ray.x - at.x - 60) < 0.01);
});

// The swept mover the waiting yard still uses (waiting.ts); matches move on the engine.
test('continuous analog movement is normalized', () => {
  const { map } = openField(2400), p = { role: 'contestant', x: 600, y: Y }, start = { ...p };
  movePlayer(map, p, { x: 1, y: 1 }); assert.ok(Math.abs(Math.hypot(p.x - start.x, p.y - start.y) - 9) < 0.002);
  assert.notEqual(p.x % TILE, 0);
});
