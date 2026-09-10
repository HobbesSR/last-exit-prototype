import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, setInput, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS } from '../shared/simulation.js';
import { generateMap, blockRoute } from '../shared/map.js';
import { canOccupy, lineClear, reachClear, movePlayer } from '../shared/movement.js';
import { buildingAt, roofConceals } from '../shared/view.js';
import { carriedCell } from '../shared/equipment.js';

function fixture() {
  const s = createGame(4217);
  for (const p of s.players) { p.bot = false; p.input = {}; }
  s.map.traps = []; s.map.items = [];
  return { s, p: s.players[0] };
}
function press(s, p, values) { setInput(s, p.id, { seq: p.lastSeq + 1, ...values }); step(s); }

test('street mazes are connected, loopy, vertically rewarding, and keep spawns and loot separated', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const m = generateMap(seed);
    assert.equal(m.width, 24000); assert.equal(m.height, 12000);
    assert.ok(m.streets.length > m.nodes.length - 1, `loops seed ${seed}`);
    for (const n of m.nodes) assert.ok(blockRoute(m, m.nodes[0], n).length);
    assert.ok(m.buildings.length > 10);
    assert.ok(m.chargers.some(c => c.y < m.height / 3));
    assert.ok(m.chargers.some(c => c.y > m.height * 2 / 3));
    assert.equal(lineClear(m, m.entry, m.exit), false, 'no straight-through highway');
    // A minute at spawn, then travel with a pause at every route point must remain survivable.
    let seconds = 60;
    for (let i = 1; i < m.routes[0].points.length; i++) {
      const a = m.routes[0].points[i - 1], b = m.routes[0].points[i];
      seconds += Math.hypot(b.x - a.x, b.y - a.y) / 180 + 1;
      assert.ok(b.x > -80 + Math.max(0, seconds - 60) / 540 * (m.width + 100) + 400, `wall slack seed ${seed}`);
    }
    for (const p of m.spawns) {
      assert.ok(canOccupy(m, p.x, p.y, 25));
      assert.ok(m.items.some(i => i.kind === 'weapon' && Math.hypot(p.x - i.x, p.y - i.y) <= 40));
    }
    for (let i = 0; i < m.spawns.length; i++) for (let j = i + 1; j < m.spawns.length; j++)
      assert.ok(Math.hypot(m.spawns[i].x - m.spawns[j].x, m.spawns[i].y - m.spawns[j].y) >= 400);
    assert.equal(new Set(m.spawns.map(p => Math.floor(p.x / 1000) + ',' + Math.floor(p.y / 1000))).size, 4);
    for (const b of m.buildings) assert.ok(m.items.some(i => i.buildingId === b.id && ['weapon', 'cell'].includes(i.kind)), `useful indoor loot ${b.id}`);
    const objects = [...m.items, ...m.chargers, ...m.stations, ...m.traps];
    for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++)
      assert.ok(Math.hypot(objects[i].x - objects[j].x, objects[i].y - objects[j].y) >= 55, `overlap seed ${seed}`);
  }
});

test('building roofs hide interiors outside, while windows pass sight and bullets but block movement and hands', () => {
  const { s, p } = fixture(), b = s.map.buildings[0];
  const inside = { x: b.x + 125, y: b.y + 60 }, outside = { x: b.x + 125, y: b.y - 60 };
  assert.equal(buildingAt(s.map, inside)?.id, b.id);
  assert.equal(roofConceals(s.map, outside, inside), true);
  assert.equal(roofConceals(s.map, inside, inside), false);
  assert.equal(roofConceals(s.map, inside, outside), false);
  assert.equal(lineClear(s.map, inside, outside), true);
  assert.equal(reachClear(s.map, inside, outside), false);
  assert.equal(canOccupy(s.map, b.x + 125, b.y + 9, 2, false, true), true);
  assert.equal(canOccupy(s.map, b.x + 125, b.y + 9, 12), false);
  Object.assign(p, inside);
  for (let i = 0; i < 20; i++) movePlayer(s.map, p, { y: -1 });
  assert.ok(p.y >= b.y + 29.9, 'body stays behind window');
});

test('doors open, admit both body sizes, close, and refuse to close on an occupant', () => {
  const { s, p } = fixture(), door = s.map.gates.find(g => !g.locked);
  Object.assign(p, { x: door.x, y: door.y + 55 });
  assert.equal(canOccupy(s.map, door.x, door.y, 23), false);
  press(s, p, { interact: true }); assert.equal(door.open, true);
  assert.equal(canOccupy(s.map, door.x, door.y, 23), true);
  const other = s.players[1]; Object.assign(other, { x: door.x, y: door.y });
  press(s, p, { interact: true }); assert.equal(door.open, true);
  other.x += 200;
  press(s, p, { interact: true }); assert.equal(door.open, false);
});

test('dropping a selected charged cell frees a slot, preserves charge, and does not immediately collect it again', () => {
  const { s, p } = fixture();
  p.inventory[0] = { kind: 'cell', charge: CELL_CHARGE_TICKS };
  press(s, p, { drop: true });
  assert.equal(carriedCell(p), null);
  const cell = s.map.items.find(i => i.kind === 'cell');
  assert.equal(cell.charge, CELL_CHARGE_TICKS);
  assert.ok(canOccupy(s.map, cell.x, cell.y, 16));
  Object.assign(p, { x: cell.x, y: cell.y });
  step(s); assert.equal(carriedCell(p), null);
  for (let i = 0; i < 20; i++) step(s);
  assert.equal(carriedCell(p)?.charge, CELL_CHARGE_TICKS);
});

test('gladiators killed by contestants respawn after twenty seconds with upgrades retained and safe placement', () => {
  const { s, p } = fixture(), g = s.players.find(p => p.role === 'gladiator');
  Object.assign(g, { x: p.x + 32, y: p.y, hp: 1, maxHp: 400, level: 3, kills: 2 });
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol' };
  press(s, p, { attack: true, aim: 0 });
  assert.equal(g.status, 'respawning'); assert.equal(p.kills, 1);
  assert.equal(g.respawnAt - s.tick, GLADIATOR_RESPAWN_TICKS);
  p.input = {};
  for (let i = 0; i < GLADIATOR_RESPAWN_TICKS - 1; i++) step(s);
  assert.equal(g.status, 'respawning'); step(s);
  assert.equal(g.status, 'active'); assert.equal(g.hp, 400); assert.equal(g.level, 3); assert.equal(g.kills, 2);
  assert.ok(g.x > s.hazardX + 400);
  assert.ok(s.players.filter(p => p.role === 'contestant').every(p => Math.hypot(p.x - g.x, p.y - g.y) > 1000));
});

test('loot across a window cannot be collected even at pickup distance', () => {
  const { s, p } = fixture(), b = s.map.buildings[0];
  Object.assign(p, { x: b.x + 100, y: b.y - 13 });
  s.map.items = [{ id: 'window-cell', kind: 'cell', x: p.x, y: b.y + 24 }];
  step(s);
  assert.equal(carriedCell(p), null); assert.equal(s.map.items.length, 1);
});

test('bots open a building door to retrieve an indoor objective', () => {
  const { s, p } = fixture(), door = s.map.gates.find(g => !g.locked);
  const b = s.map.buildings.find(b => b.id === door.buildingId);
  Object.assign(p, { x: door.x, y: door.y + 70, bot: true });
  s.map.items = [{ id: 'indoor-cell', kind: 'cell', buildingId: b.id, x: b.x + 125, y: b.y + 125 }];
  for (let i = 0; i < 150 && !carriedCell(p); i++) step(s);
  assert.equal(door.open, true); assert.ok(carriedCell(p));
});

test('with combat damage neutralized, bots complete the cell objective and fill all three pods through the maze', () => {
  for (const seed of [1, 9, 4217]) {
    const s = createGame(seed); s.map.traps = [];
    // Isolate objective navigation from the separately tested proactive PvP and finite ammo.
    for (const p of s.players) if (p.role === 'gladiator') p.status = 'eliminated'; else p.shield = 1000000;
    while (s.phase === 'live') step(s);
    assert.equal(s.players.filter(p => p.status === 'escaped').length, 3, `seed ${seed}`);
  }
});

test('contestant bots initiate close-range fights after opening grace without being attacked first', () => {
  const { s, p } = fixture(), target = s.players[1];
  Object.assign(target, { x: p.x + 85, y: p.y });
  p.bot = true; p.inventory[0] = { kind: 'weapon', weaponType: 'pistol' };
  for (let i = 0; i < 5; i++) step(s);
  assert.equal(target.hp, 100, 'opening grace avoids an immediate spawn fight');
  s.tick = 601;
  for (let i = 0; i < 10; i++) step(s);
  assert.ok(target.hp < 100, 'nearby contestant is challenged without retaliation trigger');
});

test('armed contestant bots create distance from a nearby hunter instead of walking into melee', () => {
  const { s, p } = fixture(), hunter = s.players.find(p => p.role === 'gladiator');
  Object.assign(hunter, { x: p.x + 100, y: p.y });
  p.bot = true; p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48 };
  for (let i = 0; i < 12; i++) step(s);
  assert.ok(Math.hypot(p.x - hunter.x, p.y - hunter.y) > 150);
  assert.ok(hunter.hp < hunter.maxHp, 'retreating bot can still return fire');
});
