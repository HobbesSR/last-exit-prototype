import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, generateMap, joinGame, setInput, step, snapshot, visibleTo, couldSee, playerView, POTENTIAL, TILE, DURATION, CELL_CHARGE_TICKS } from '../shared/simulation.js';
import { movePlayer, canOccupy, lineClear, visibilityPolygon } from '../shared/movement.js';
import { navigationGrid } from '../shared/map.js';
import PF from 'pathfinding';
import { collectEquipment, carriedCell } from '../shared/equipment.js';

function fixture(role = 'contestant', kit = 'warden') {
  const s = createGame(4217);
  for (const p of s.players) { p.bot = false; p.input = {}; }
  const p = s.players.find(p => p.role === role); p.kit = kit;
  return { s, p };
}
function input(s, p, values) { assert.ok(setInput(s, p.id, { seq: p.lastSeq + 1, ...values })); step(s); }
test('seeded generation and fixed simulation produce identical complete frames', () => {
  assert.deepEqual(generateMap(9843), generateMap(9843));
  assert.notDeepEqual(generateMap(9843).obstacles, generateMap(9844).obstacles);
  const a = createGame(11), b = createGame(11);
  for (let i = 0; i < 500; i++) { step(a); step(b); assert.deepEqual(snapshot(a), snapshot(b)); }
});
test('200 generated maps have a no-key route for both body sizes', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = createGame(seed);
    for (const role of ['contestant', 'gladiator']) {
      const matrix = navigationGrid(s.map, role);
      const start = s.players[0], end = s.map.exit;
      const route = new PF.AStarFinder().findPath(Math.floor(start.x / TILE), Math.floor(start.y / TILE), Math.floor(end.x / TILE), Math.floor(end.y / TILE), new PF.Grid(matrix));
      assert.ok(route.length > 0, `seed ${seed}, ${role}`);
    }
    assert.ok(s.map.items.every(i => canOccupy(s.map, i.x, i.y, 12)), `loot seed ${seed}`);
    assert.ok(s.map.chargers.every(i => canOccupy(s.map, i.x, i.y, 25)), `chargers seed ${seed}`);
    for (const route of s.map.routes) for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      const samples = Math.ceil(length / 20);
      for (let j = 0; j <= samples; j++) assert.ok(canOccupy(s.map, a.x + (b.x - a.x) * j / samples, a.y + (b.y - a.y) * j / samples, 25), `seed ${seed} ${route.band} segment ${i} sample ${j}`);
    }
  }
});

test('route distance leaves exploration time within a ten-minute match and the wall reaches the end at ten minutes', () => {
  const { s, p } = fixture();
  for (const route of s.map.routes.slice(0, 1)) {
    const length = route.points.slice(1).reduce((sum, b, i) => sum + Math.hypot(b.x - route.points[i].x, b.y - route.points[i].y), 0);
    const seconds = length / (9 * 20) + CELL_CHARGE_TICKS / 20;
    assert.ok(seconds > 220 && seconds < 320, `${route.band}: ${seconds} seconds before combat/detours`);
  }
  s.tick = DURATION - 1; Object.assign(p, s.map.exit);
  step(s); assert.ok(s.hazardX >= s.map.width); assert.equal(s.phase, 'finished');
});
test('clients cannot send positions or amplify movement and stale inputs are rejected', () => {
  const { s, p } = fixture(); const x = p.x;
  input(s, p, { x: 999, y: 0, hp: 9999, keys: 9999, position: { x: 3000 } });
  assert.equal(p.x, x + 9); assert.equal(p.hp, 100); assert.equal(p.keys, 0);
  assert.equal(setInput(s, p.id, { seq: p.lastSeq, x: 1 }), false);
  for (let i = 0; i < 11; i++) step(s);
  const stopped = p.x; step(s); assert.equal(p.x, stopped);
  input(s, p, { x: { toString: null, valueOf: null }, y: [999] }); assert.equal(p.x, stopped);
});
test('contestants can traverse gaps that block larger gladiators', () => {
  const { s, p } = fixture();
  const gap = s.map.gaps[0];
  assert.ok(canOccupy(s.map, gap.x, gap.y, 12));
  assert.equal(canOccupy(s.map, gap.x, gap.y, 23), false);
  p.x = gap.x - 65; p.y = gap.y;
  for (let i = 0; i < 16; i++) movePlayer(s.map, p, { x: 1 }); assert.ok(p.x > gap.x + 40);
  p.role = 'gladiator'; p.x = gap.x - 65; p.y = gap.y;
  for (let i = 0; i < 16; i++) movePlayer(s.map, p, { x: 1 }); assert.ok(p.x < gap.x);
});
test('locked building doors require a key and stay unlocked', () => {
  const { s, p } = fixture(); const g = s.map.gates.find(g => g.locked);
  s.map.items = [];
  p.x = g.x; p.y = g.y + 55;
  input(s, p, { interact: true }); assert.equal(g.open, false);
  p.keys = 1; input(s, p, { interact: true }); assert.equal(g.open, true); assert.equal(p.keys, 0);
  input(s, p, { interact: true }); assert.equal(p.keys, 0);
  assert.equal(g.locked, false, 'unlocking is permanent');
});
test('only three contestants can extract, and gladiators cannot consume exits', () => {
  const { s, p } = fixture('gladiator');
  Object.assign(p, s.map.exit); input(s, p, { interact: true }); assert.equal(s.slots, 3);
  for (const c of s.players.filter(p => p.role === 'contestant')) { Object.assign(c, s.map.exit, { inventory: [{ kind: 'cell', charge: CELL_CHARGE_TICKS }, null, null, null, null] }); setInput(s, c.id, { seq: 0, interact: true }); }
  step(s);
  assert.equal(s.slots, 0); assert.equal(s.players.filter(p => p.status === 'escaped').length, 3);
  assert.equal(s.phase, 'finished');
});

test('power-cell objective requires pickup, stationary charging, and delivery; movement pauses progress', () => {
  const { s, p } = fixture();
  Object.assign(p, s.map.exit);
  input(s, p, { interact: true }); assert.equal(s.slots, 3);
  const cell = s.map.items.find(i => i.kind === 'cell');
  Object.assign(p, { x: cell.x, y: cell.y }); input(s, p, {});
  assert.equal(carriedCell(p).charge, 0); assert.ok(!s.map.items.includes(cell));
  Object.assign(p, s.map.exit); input(s, p, { interact: true }); assert.equal(s.slots, 3);
  Object.assign(p, { x: s.map.chargers[0].x, y: s.map.chargers[0].y });
  input(s, p, { interact: true }); assert.equal(carriedCell(p).charge, 1);
  input(s, p, { x: 1 }); assert.equal(carriedCell(p).charge, 1); assert.equal(p.charging, null);
  input(s, p, { interact: true });
  for (let i = carriedCell(p).charge; i < CELL_CHARGE_TICKS; i++) step(s);
  assert.equal(carriedCell(p).charge, CELL_CHARGE_TICKS); assert.equal(p.charging, null);
  Object.assign(p, s.map.exit); input(s, p, { interact: true });
  assert.equal(p.status, 'escaped'); assert.equal(carriedCell(p), null); assert.equal(s.slots, 2);
});

test('cells take individual slots and retain charge when dropped on death', () => {
  const { s, p } = fixture();
  p.inventory = Array.from({ length: 5 }, (_, i) => i < 4 ? { kind: 'weapon', weaponType: 'pistol' } : null);
  s.map.items = [{ id: 'a', kind: 'cell', x: p.x, y: p.y }, { id: 'b', kind: 'cell', x: p.x, y: p.y }];
  step(s); assert.equal(s.map.items.length, 1);
  carriedCell(p).charge = 55;
  const hunter = s.players.find(p => p.role === 'gladiator');
  hunter.x = p.x + 40; hunter.y = p.y; p.hp = 1;
  input(s, hunter, { attack: true, aim: Math.PI });
  assert.equal(p.status, 'eliminated'); assert.equal(carriedCell(p), null);
  assert.ok(s.map.items.some(i => i.kind === 'cell' && i.charge === 55));
});

test('gladiator kills upgrade the kit and refill ability, contestants can damage other contestants', () => {
  const { s, p } = fixture('gladiator'); const target = s.players[0];
  for (const other of s.players.filter(other => other.role === 'contestant' && other !== target)) other.x += 400;
  p.x = target.x + 40; p.y = target.y; target.hp = 1; p.cooldown = 80;
  input(s, p, { attack: true, aim: Math.PI });
  assert.equal(target.status, 'eliminated'); assert.equal(p.kills, 1); assert.equal(p.level, 2); assert.equal(p.cooldown, 0);
  const a = s.players[1], b = s.players[2]; collectEquipment(a, { kind: 'weapon', weaponType: 'pistol' }); b.x = a.x + 24; b.y = a.y;
  input(s, a, { attack: true, aim: 0 }); assert.equal(b.hp, 90);
});
test('rail travel is gladiator-only, has a cooldown, and skips consumed stations', () => {
  const { s, p } = fixture('gladiator');
  Object.assign(p, { x: s.map.stations[0].x, y: s.map.stations[0].y });
  input(s, p, { interact: true }); assert.equal(p.x, s.map.stations[1].x); assert.equal(p.railCd, 180);
  input(s, p, { interact: true }); assert.equal(p.x, s.map.stations[1].x);
  const c = s.players[0]; c.x = s.map.stations[0].x; c.y = s.map.stations[0].y;
  input(s, c, { interact: true }); assert.equal(c.x, s.map.stations[0].x);
});
test('sneaking avoids sensors, contestants have no innate skill, hazard affects gladiators too', () => {
  const { s, p } = fixture(); Object.assign(p, { x: s.map.sensors[0].x, y: s.map.sensors[0].y });
  input(s, p, { sneak: true }); assert.equal(p.revealed, 0);
  input(s, p, {}); assert.ok(p.revealed > 0);
  input(s, p, { skill: true }); assert.equal(p.cooldown, 0); assert.equal(p.cloak, 0);
  s.tick = DURATION - 11;
  const g = s.players.find(p => p.role === 'gladiator'); const hp = g.hp;
  step(s); assert.ok(g.hp < hp);
});
test('snapshots are independent copies including bot paths and accepted input', () => {
  const s = createGame(); step(s); const frame = snapshot(s);
  const before = JSON.stringify(frame); for (let i = 0; i < 20; i++) step(s);
  assert.equal(JSON.stringify(frame), before);
});
test('joining claims an active bot and refuses a finished match', () => {
  const s = createGame(); const p = joinGame(s, 'human', 'gladiator', 'striker', 'Guest');
  assert.equal(p.bot, false); assert.equal(p.kit, 'striker');
  s.phase = 'finished'; assert.equal(joinGame(s, 'late'), null);
});
test('directed views are unfogged, player views withhold private fields, and neither carries bookkeeping', () => {
  const s = createGame(4217);
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
  const { s, p } = fixture();
  const frame = snapshot(s);
  p.status = 'eliminated'; p.id = 'replacement';
  const view = playerView(s, frame, frame.players[0].id);
  assert.equal(view.directed, false);
  assert.equal(view.contestantsActive, 8);
  assert.equal(playerView(s, frame, null).contestantsActive, 8);
});
test('the server transmits what could become visible while gameplay still turns on true sight', () => {
  const { s, p } = fixture('gladiator'); const c = s.players[0];
  // Put a contestant close behind solid cover: reachable, but not actually in sight.
  c.x = p.x + 150; c.y = p.y;
  s.map.obstacles.push({ id: 'sight-block', x: p.x + 60, y: p.y - 80, w: 30, h: 160, kind: 'fence' });
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
});
test('a one-shot press is not erased by the next input arriving before the tick', () => {
  const { s, p } = fixture('gladiator');
  // Two client messages between two server ticks: the second carries no press, as a real client sends.
  assert.ok(setInput(s, p.id, { seq: 1, skill: true }));
  assert.ok(setInput(s, p.id, { seq: 2, x: 1 }));
  step(s);
  assert.ok(p.cooldown > 0, 'the ability still fired');
  assert.equal(p.input.skill, false, 'and the latch was spent');
  const cooldown = p.cooldown;
  for (let i = 0; i < 3; i++) step(s);
  assert.equal(p.cooldown, cooldown - 3, 'it does not fire again on later ticks');
  const { s: s2, p: p2 } = fixture();
  p2.x = s2.map.gates[0].x - 40; p2.y = s2.map.gates[0].y; p2.keys = 1;
  assert.ok(setInput(s2, p2.id, { seq: 1, interact: true }));
  assert.ok(setInput(s2, p2.id, { seq: 2, x: 0 }));
  step(s2);
  assert.equal(s2.map.gates[0].open, true, 'the same holds for interact');
});
test('live visibility hides distant and cloaked enemies, sensor reveals restore tracking', () => {
  const { s, p } = fixture('gladiator'); const c = s.players[0];
  assert.equal(visibleTo(s, p, c), false);
  assert.equal(playerView(s, snapshot(s), p.id).players.some(t => t.id === c.id), false);
  p.x = c.x + 40; p.y = c.y; assert.equal(visibleTo(s, p, c), true);
  c.cloak = 10; assert.equal(visibleTo(s, p, c), false);
  c.revealed = 10; assert.equal(visibleTo(s, p, c), true);
  c.cloak = 0; c.revealed = 0; p.x = c.x + 150; s.map.obstacles.push({ id: 'test-wall', x: c.x + 65, y: c.y - 60, w: 25, h: 120, kind: 'fence' });
  assert.equal(visibleTo(s, p, c), false);
});
test('continuous analog movement is normalized and vision polygon stops at solid cover', () => {
  const { s, p } = fixture(); const start = { x: p.x, y: p.y };
  movePlayer(s.map, p, { x: 1, y: 1 }); assert.ok(Math.abs(Math.hypot(p.x - start.x, p.y - start.y) - 9) < 0.002);
  assert.notEqual(p.x % TILE, 0);
  s.map.obstacles.push({ id: 'test-wall', x: p.x + 60, y: p.y - 100, w: 30, h: 200 });
  assert.equal(lineClear(s.map, p, { x: p.x + 150, y: p.y }), false);
  const ray = visibilityPolygon(s.map, p).find(v => v.x > p.x && Math.abs(v.y - p.y) < 0.001);
  assert.ok(Math.abs(ray.x - p.x - 60) < 0.01);
});
