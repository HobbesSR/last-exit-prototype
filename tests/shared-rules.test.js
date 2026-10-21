import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, setInput } from '../shared/simulation.ts';
import { nearbyGate } from '../shared/gate-query.ts';
import { canOccupy } from '../shared/movement.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { GATE_REACH, RESPAWN_CLEARANCE_RADIUS, RESPAWN_HAZARD_MARGIN } from '../shared/simulation/rules.ts';

const gate = (id, x, y, extra = {}) => ({ id, x, y, w: 26, h: 54, open: false, locked: false, kind: 'door', ...extra });
const area = (gates, obstacles = []) => ({ width: 4000, height: 4000, obstacles, gates });
const any = () => true;

test('a gate is reachable strictly inside the reach, with only itself ignored for sight', () => {
  const at = { x: 1000, y: 1000 };
  for (const [offset, found] of [[GATE_REACH - 0.001, true], [GATE_REACH, false], [GATE_REACH + 0.001, false]]) {
    const map = area([gate('g', 1000 + offset, 1000)]);
    assert.equal(nearbyGate(map, at, { accepts: any, order: 'nearest' })?.id, found ? 'g' : undefined, `offset ${offset}`);
    assert.equal(nearbyGate(map, at, { accepts: any, order: 'map' })?.id, found ? 'g' : undefined, `offset ${offset}`);
  }
  const walled = area([gate('g', 1070, 1000)], [{ id: 'wall', x: 1030, y: 950, w: 10, h: 100 }]);
  assert.equal(nearbyGate(walled, at, { accepts: any, order: 'nearest' }), undefined, 'a wall blocks the line');
  const behind = area([gate('far', 1080, 1000), gate('near', 1040, 1000, { w: 10, h: 100 })]);
  assert.equal(nearbyGate(behind, at, { accepts: g => g.id === 'far', order: 'nearest' }), undefined, 'another closed gate blocks the line');
  behind.gates[1].open = true;
  assert.equal(nearbyGate(behind, at, { accepts: g => g.id === 'far', order: 'nearest' })?.id, 'far', 'an open one does not');
});

test('nearest keeps map order among equal distances; map order takes the first qualifying gate', () => {
  const at = { x: 1000, y: 1000 };
  const gates = [gate('far', 1000, 1070), gate('east', 1040, 1000), gate('west', 960, 1000)];
  const map = area(gates);
  assert.equal(nearbyGate(map, at, { accepts: any, order: 'nearest' }).id, 'east');
  assert.equal(nearbyGate(map, at, { accepts: any, order: 'map' }).id, 'far');
  assert.deepEqual(map.gates.map(g => g.id), ['far', 'east', 'west'], 'the gate array is not sorted in place');
  assert.equal(nearbyGate(map, at, { accepts: any, order: 'nearest' }), gates[1], 'the original gate, not a copy');
  map.gates.reverse();
  assert.equal(nearbyGate(map, at, { accepts: any, order: 'nearest' }).id, 'west');
  assert.equal(nearbyGate(map, at, { accepts: g => g.kind === 'door' && g.id !== 'west', order: 'map' }).id, 'east');
});

// A contestant standing on open ground, everything else cleared away and far off.
function arena(gates, role = 'contestant') {
  const s = createGame(4217);
  for (const q of s.players) { q.bot = false; q.input = {}; q.x = 200; q.y = 200; }
  const p = s.players.find(q => q.role === role);
  Object.assign(s.map, { obstacles: [], items: [], traps: [], chargers: [], gates });
  p.x = 3000; p.y = 6000;
  return { s, p };
}
const press = (s, p, values) => { setInput(s, p.id, { seq: p.lastSeq + 1, ...values }); step(s); };

test('the nearest gate takes the interaction even when it cannot be used', () => {
  const { s, p } = arena([gate('locked', 3040, 6000, { locked: true }), gate('free', 3060, 6000)]);
  press(s, p, { interact: true });
  assert.deepEqual(s.map.gates.map(g => g.open), [false, false], 'a locked keyless door does not fall through to the next');
  p.keys = 1; press(s, p, { interact: true });
  assert.deepEqual(s.map.gates.map(g => [g.open, g.locked]), [[true, false], [false, false]]);
  assert.equal(p.keys, 0);
  const legacy = arena([gate('old', 3040, 6000, { kind: 'gate', locked: undefined })]);
  press(legacy.s, legacy.p, { interact: true });
  assert.equal(legacy.s.map.gates[0].open, false, 'a non-door gate without a lock flag is locked');
});

test('a bot skips open gates; a locked gate near a rail station stops transit', () => {
  const { s, p } = arena([gate('open', 3030, 6000, { open: true }), gate('shut', 3070, 6000)], 'gladiator');
  p.bot = true; p.path = [{ x: 1, y: 1 }];
  const [x, y] = [p.x, p.y];
  s.map.stations = [{ id: 'here', x: 3000, y: 6000 }, { id: 'there', x: 3500, y: 6000 }];
  interact(s, p);
  assert.deepEqual(s.map.gates.map(g => g.open), [true, true], 'the bot opened the closed gate past the open one');
  assert.deepEqual(p.path, []);
  s.map.gates[1].open = false; s.map.gates[1].locked = true; p.bot = false;
  s.map.gates[0].open = false; s.map.gates[0].locked = true;
  interact(s, p);
  assert.deepEqual([p.x, p.y], [x, y], 'no fall through to the rail station');
  s.map.gates = [];
  interact(s, p);
  assert.deepEqual([p.x, p.y], [3500, 6000], 'which carries them once no gate is in reach');
});

test('closing a door is refused on strict overlap with an active body, at each body radius', () => {
  for (const [role, radius] of [['contestant', 12], ['gladiator', 23]]) {
    for (const [gap, closes] of [[radius, true], [radius - 0.01, false]]) {
      const door = gate('door', 3040, 6000, { open: true });
      const { s, p } = arena([door]);
      const other = s.players.find(q => q !== p && q.role === role);
      // The door box spans x 3027..3053; stand the other body to its right at `gap`.
      Object.assign(other, { x: 3053 + gap, y: 6000, status: 'active' });
      press(s, p, { interact: true });
      assert.equal(door.open, !closes, `${role} at ${gap}`);
    }
  }
  const door = gate('door', 3040, 6000, { open: true });
  const { s, p } = arena([door]);
  Object.assign(s.players.find(q => q.role === 'gladiator'), { x: 3060, y: 6000, status: 'respawning' });
  press(s, p, { interact: true });
  assert.equal(door.open, false, 'only active players block');
});

test('respawn needs the 25-unit clearance, not the 23-unit gladiator body', () => {
  for (const [gap, returns] of [[24, false], [26, true]]) {
    const s = createGame(4217);
    for (const q of s.players) { q.bot = false; q.input = {}; if (q.role === 'contestant') Object.assign(q, { x: 200, y: 200 }); }
    const g = s.players.find(q => q.role === 'gladiator');
    const station = s.map.stations.at(-1);
    assert.ok(station.x > s.hazardX + RESPAWN_HAZARD_MARGIN);
    s.map.stations = [station];
    s.map.obstacles.push({ id: 'crowd', x: station.x + gap, y: station.y - 50, w: 20, h: 100 });
    assert.equal(canOccupy(s.map, station.x, station.y, 23), true);
    assert.equal(canOccupy(s.map, station.x, station.y, RESPAWN_CLEARANCE_RADIUS), returns);
    Object.assign(g, { status: 'respawning', respawnAt: s.tick + 1, x: 0, y: 0 });
    step(s);
    assert.equal(g.status, returns ? 'active' : 'respawning', `gap ${gap}`);
  }
});
