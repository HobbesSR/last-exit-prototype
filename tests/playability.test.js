import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, step, setInput, CELL_CHARGE_TICKS } from '../shared/simulation.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { ItemMemory } from '../shared/simulation/bot-memory.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { canOccupy, lineClear, reachClear } from '../shared/movement.ts';
import { buildingAt, roofConceals } from '../shared/view.ts';
import { carriedCell } from '../shared/equipment.ts';
import { openField } from './helpers/arena.js';
import { everywhere, stagePhysics } from './helpers/scenario.js';

// On the shipped content and its engine (#920 stage 2b). The streets generator's own property (connected, loopy
// street mazes with separated spawns) went with the legacy generator; the engine pins a map's obstacles and gates at
// creation, so each case builds its scene first. Every match keeps a contestant (and a hunter)
// parked far off and played by the test, so eliminating or crowding the one under test ends nothing.
const content = defaultContent();
const Y = 576, LENGTH = 3600;
const PARK = [{ role: 'contestant', bot: false, x: 200, y: 150 }, { role: 'gladiator', bot: false, x: 200, y: 1000 }];
const stage = (map, actors) => stagePhysics(map, { content, actors: [...actors, ...PARK] });
const dispose = async (made, body) => { try { await body(made); } finally { disposePhysics(made.s); } };
const press = (s, p, values) => { setInput(s, p.id, { seq: p.lastSeq + 1, ...values }); step(s); };
const hold = (s, p, values, ticks) => { for (let i = 0; i < ticks; i++) press(s, p, values); };

// A hall of four 18-unit walls at HALL, 250 square. Its north wall has a 50-wide window; its south wall is solid, or
// with `door` has an 80-wide doorway holding a closed door. Roofs are the building's own box.
const HALL = { x: 1000, y: 300, w: 250, h: 250 }, WALL = 18, WINDOW = { x: 1100, w: 50 }, DOOR = { x: 1085, w: 80 };
function hall({ door = false, items = [], extra = {} } = {}) {
  const { x, y, w, h } = HALL, south = y + h - WALL;
  const wall = (id, ox, oy, ow, oh, kind = 'building') => ({ id, kind, x: ox, y: oy, w: ow, h: oh, buildingId: 'hall' });
  const obstacles = [
    wall('north-west', x, y, WINDOW.x - x, WALL), wall('window', WINDOW.x, y, WINDOW.w, WALL, 'window'), wall('north-east', WINDOW.x + WINDOW.w, y, x + w - WINDOW.x - WINDOW.w, WALL),
    wall('west', x, y + WALL, WALL, h - 2 * WALL), wall('east', x + w - WALL, y + WALL, WALL, h - 2 * WALL),
    ...door ? [wall('south-west', x, south, DOOR.x - x, WALL), wall('south-east', DOOR.x + DOOR.w, south, x + w - DOOR.x - DOOR.w, WALL)] : [wall('south', x, south, w, WALL)],
  ];
  const gates = door ? [{ id: 'door', kind: 'door', x: DOOR.x + DOOR.w / 2, y: south + WALL / 2, w: DOOR.w, h: WALL, open: false, locked: false, buildingId: 'hall' }] : [];
  return openField(LENGTH, { buildings: [{ id: 'hall', ...HALL }], obstacles, gates, items, ...extra }).map;
}
const INSIDE = { x: HALL.x + 125, y: HALL.y + 60 }, OUTSIDE = { x: HALL.x + 125, y: HALL.y - 60 };

// The geometry rules need no game: a map holding the building is enough.
test('building roofs hide interiors outside, while windows pass sight and bullets but block movement and hands', () => {
  const map = hall(), b = map.buildings[0];
  assert.equal(buildingAt(map, INSIDE)?.id, b.id);
  assert.equal(roofConceals(map, OUTSIDE, INSIDE), true);
  assert.equal(roofConceals(map, INSIDE, INSIDE), false);
  assert.equal(roofConceals(map, INSIDE, OUTSIDE), false);
  assert.equal(lineClear(map, INSIDE, OUTSIDE), true);
  assert.equal(reachClear(map, INSIDE, OUTSIDE), false);
  assert.equal(canOccupy(map, b.x + 125, b.y + 9, 2, false, true), true);
  assert.equal(canOccupy(map, b.x + 125, b.y + 9, 12), false);
});

// Each role's body, pushed at an opening for a second, stays behind it (the engine's bodies).
test('a body pushed at a window stays behind it, whichever role it is', async () => {
  for (const role of ['contestant', 'gladiator']) {
    await dispose(await stage(hall(), [{ role, bot: false, ...INSIDE }]), ({ s, players: [p] }) => {
      hold(s, p, { y: -1 }, 20);
      const gap = HALL.y + WALL + actorRadius(s, p);
      assert.ok(p.y >= gap - 0.5, `${role} stays behind the window: ${p.y} against ${gap}`);
      assert.ok(p.y < INSIDE.y, `${role} reached it`);
    });
  }
});

test('a pipe run, like a window, passes sight and bullets but blocks movement and hands', async () => {
  const spot = { x: 1800, y: Y }, pipe = { id: 'pipe-test', kind: 'pipe', x: spot.x - 60, y: spot.y - 6, w: 120, h: 12 };
  const north = { x: spot.x, y: spot.y - 50 }, south = { x: spot.x, y: spot.y + 50 };
  const { map } = openField(LENGTH, { obstacles: [pipe] });
  assert.equal(lineClear(map, north, south), true);
  assert.equal(reachClear(map, north, south), false);
  assert.equal(canOccupy(map, spot.x, spot.y, 2, false, true), true);
  assert.equal(canOccupy(map, spot.x, spot.y, 12), false);
  for (const role of ['contestant', 'gladiator']) {
    await dispose(await stage(structuredClone(map), [{ role, bot: false, ...north }]), ({ s, players: [p] }) => {
      hold(s, p, { y: 1 }, 20);
      assert.ok(p.y < spot.y - 6, `${role} stays behind the pipe: ${p.y}`);
      assert.ok(p.y > north.y, `${role} reached it`);
    });
  }
});

// Opening and closing a door, and the refusal to close on a body, are shared-rules' (the nearest gate takes the
// interaction; closing is refused while an active body overlaps it, at each body radius). What stays here is what the
// door admits.
test('a door blocks both bodies until it is opened, and then admits them', async () => {
  const { x, y } = { x: DOOR.x + DOOR.w / 2, y: HALL.y + HALL.h - WALL / 2 };
  for (const role of ['contestant', 'gladiator']) {
    await dispose(await stage(hall({ door: true }), [{ role, bot: false, x, y: y + 55 }]), ({ s, players: [p] }) => {
      const door = s.map.gates[0], r = actorRadius(s, p);
      assert.equal(canOccupy(s.map, x, y, r), false, 'closed');
      hold(s, p, { y: -1 }, 10);
      assert.ok(p.y > y, `${role} stopped at the closed door: ${p.y}`);
      press(s, p, { interact: true });
      assert.equal(door.open, true);
      assert.equal(canOccupy(s.map, x, y, r), true, 'open');
      hold(s, p, { y: -1 }, 30);
      assert.ok(p.y < y - WALL, `${role} went through: ${p.y}`);
    });
  }
});

test('dropping a selected charged cell frees a slot, preserves charge, and does not immediately collect it again', async () => {
  await dispose(await stage(openField(LENGTH).map, [{ role: 'contestant', bot: false, x: 1500, y: Y }]), ({ s, players: [p] }) => {
    p.inventory[0] = { kind: 'cell', charge: CELL_CHARGE_TICKS, instanceId: 'held-cell', lineageId: 'held-cell' };
    // The dropper may not take it back for one second (14 "Equipment"), counted from the tick the drop is spent on,
    // which a step numbers before it runs: stated here rather than read off the dropped record, so a shortened
    // delay fails.
    const droppedOn = s.tick + 1, free = droppedOn + HZ;
    press(s, p, { drop: true });
    assert.equal(carriedCell(p), null);
    const cell = s.map.items.find(i => i.kind === 'cell');
    assert.equal(cell.charge, CELL_CHARGE_TICKS);
    assert.equal(cell.pickupAfter, free, 'the record carries the one-second delay');
    assert.ok(canOccupy(s.map, cell.x, cell.y, actorRadius(s, p)));
    // Standing on it, the dropper is refused until the delay has passed; then it is theirs again, charge intact.
    let collected = null;
    for (let i = 0; i < 3 * HZ && !collected; i++) {
      Object.assign(p, { x: cell.x, y: cell.y });
      step(s);
      if (carriedCell(p)) collected = s.tick;
      else assert.ok(s.tick < free, `refused on tick ${s.tick}, past the delay`);
    }
    assert.equal(collected, free, `collected on the first tick the delay allows, not ${collected}`);
    assert.equal(carriedCell(p).charge, CELL_CHARGE_TICKS);
  });
});

test('gladiators killed by contestants respawn after twenty seconds with upgrades retained and safe placement', async () => {
  const station = { id: 'respawn', x: 3300, y: Y };
  const { map } = openField(LENGTH, { stations: [station] });
  await dispose(await stage(map, [{ role: 'contestant', bot: false, x: 1500, y: Y }, { role: 'gladiator', bot: false, x: 1532, y: Y }]), ({ s, players: [p, g] }) => {
    Object.assign(g, { hp: 1, maxHp: 400, level: 3, kills: 2 });
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', instanceId: 'pistol-1', lineageId: 'pistol-1' };
    setInput(s, p.id, { seq: p.lastSeq + 1, attack: true, aim: 0 });
    for (let i = 0; i < 10 && g.status !== 'respawning'; i++) step(s);
    assert.equal(g.status, 'respawning'); assert.equal(p.kills, 1);
    p.input = {};
    assert.equal(g.respawnAt - s.tick, s.content.gladiatorRespawnTicks); assert.equal(s.content.gladiatorRespawnTicks, 20 * 20, 'twenty seconds');
    const killed = s.tick;
    while (s.tick < killed + s.content.gladiatorRespawnTicks - 1) step(s);
    assert.equal(g.status, 'respawning'); step(s);
    assert.equal(g.status, 'active'); assert.equal(g.hp, 400); assert.equal(g.level, 3); assert.equal(g.kills, 2);
    assert.ok(g.x > s.hazardX + 400);
    assert.ok(s.players.filter(q => q.role === 'contestant').every(q => Math.hypot(q.x - g.x, q.y - g.y) > 1000));
  });
});

test('loot across a window cannot be collected even at pickup distance', async () => {
  // The same loot and the same distance with no window in between is collected, so the window is what refuses it.
  const cell = () => ({ id: 'window-cell', kind: 'cell', x: INSIDE.x, y: HALL.y + WALL + 8 });
  const at = { x: INSIDE.x, y: HALL.y - 12 };
  for (const [map, collects] of [[hall({ items: [cell()] }), false], [openField(LENGTH, { items: [cell()] }).map, true]]) {
    await dispose(await stage(map, [{ role: 'contestant', bot: false, ...at }]), ({ s, players: [p] }) => {
      assert.ok(Math.hypot(at.x - s.map.items[0].x, at.y - s.map.items[0].y) <= 38, 'within pickup distance');
      step(s);
      assert.equal(!!carriedCell(p), collects);
      assert.equal(s.map.items.length, collects ? 0 : 1);
    });
  }
});

// The shipped bots plan from what they remember, so each is told what it saw.
test('bots open a building door to retrieve an indoor objective', async () => {
  const cell = { id: 'indoor-cell', kind: 'cell', buildingId: 'hall', x: HALL.x + 125, y: HALL.y + 125 };
  const map = hall({ door: true, items: [cell] }), at = { x: DOOR.x + DOOR.w / 2, y: HALL.y + HALL.h - WALL / 2 + 70 };
  await dispose(await stage(map, [{ role: 'contestant', x: at.x, y: at.y, knows: { surveyed: everywhere(map), gates: new Map([['door', { open: false, locked: false }]]) } }]), ({ s, players: [p] }) => {
    // The roof hides it from outside, so the bot is told it saw it earlier (#230).
    p.discovery.items = ItemMemory.from([[cell.id, { ...cell }]]);
    for (let i = 0; i < 300 && !carriedCell(p); i++) step(s);
    assert.equal(s.map.gates[0].open, true); assert.ok(carriedCell(p));
  });
});

test('contestant bots initiate close-range fights after opening grace without being attacked first', async () => {
  await dispose(await stage(openField(LENGTH).map, [{ role: 'contestant', x: 1500, y: Y, knows: 'everything' }, { role: 'contestant', bot: false, x: 1585, y: Y }]), ({ s, players: [p, target] }) => {
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', instanceId: 'pistol-1', lineageId: 'pistol-1' };
    for (let i = 0; i < 5; i++) step(s);
    assert.equal(target.hp, 100, 'opening grace avoids an immediate spawn fight');
    s.tick = 30 * HZ + 1;
    for (let i = 0; i < 20; i++) step(s);
    assert.ok(target.hp < 100, 'nearby contestant is challenged without retaliation trigger');
  });
});

test('armed contestant bots create distance from a nearby hunter instead of walking into melee', async () => {
  await dispose(await stage(openField(LENGTH).map, [{ role: 'contestant', x: 1500, y: Y, knows: 'everything' }, { role: 'gladiator', bot: false, x: 1600, y: Y }]), ({ s, players: [p, hunter] }) => {
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48, instanceId: 'pistol-1', lineageId: 'pistol-1' };
    for (let i = 0; i < 12; i++) step(s);
    assert.ok(Math.hypot(p.x - hunter.x, p.y - hunter.y) > 150);
    assert.ok(hunter.hp < hunter.maxHp, 'retreating bot can still return fire');
  });
});
