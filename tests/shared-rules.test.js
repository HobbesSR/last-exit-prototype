import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, step, setInput } from '../shared/simulation.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { nearbyGate } from '../shared/gate-query.ts';
import { canOccupy } from '../shared/movement.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { GATE_REACH, RESPAWN_CLEARANCE_RADIUS, RESPAWN_HAZARD_MARGIN } from '../shared/simulation/rules.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

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
  map.gates = [...gates].reverse();
  assert.equal(nearbyGate(map, at, { accepts: any, order: 'nearest' }).id, 'west');
  assert.equal(nearbyGate(map, at, { accepts: g => g.kind === 'door' && g.id !== 'west', order: 'map' }).id, 'east');
});

// On the shipped content and its engine (#920): one player of `role` on open ground with everything else far off,
// all played by the test. The engine pins the map's gates and obstacles at creation, so each case builds its own.
const y = 576;
async function arena({ gates = [], obstacles = [], stations = [], role = 'contestant' } = {}) {
  const { map } = openField(4000, { gates, obstacles, stations });
  const at = { x: 3000, y }, park = [{ x: 200, y: 200 }, { x: 200, y: 900 }];
  const actors = role === 'contestant'
    ? [{ role: 'contestant', bot: false, ...at }, { role: 'contestant', bot: false, ...park[0] }, { role: 'gladiator', bot: false, ...park[1] }]
    : [{ role: 'gladiator', bot: false, ...at }, { role: 'contestant', bot: false, ...park[0] }, { role: 'contestant', bot: false, ...park[1] }];
  const { s, players } = await stagePhysics(map, { content: defaultContent(), actors });
  for (const q of s.players) q.input = {};
  return { s, p: players[0] };
}
const press = (s, p, values) => { setInput(s, p.id, { seq: p.lastSeq + 1, ...values }); step(s); };
const dispose = async (made, body) => { try { await body(made); } finally { disposePhysics(made.s); } };

test('the nearest gate takes the interaction even when it cannot be used', async () => {
  await dispose(await arena({ gates: [gate('locked', 3040, y, { locked: true }), gate('free', 3060, y)] }), ({ s, p }) => {
    press(s, p, { interact: true });
    assert.deepEqual(s.map.gates.map(g => g.open), [false, false], 'a locked keyless door does not fall through to the next');
    p.keys = 1; press(s, p, { interact: true });
    assert.deepEqual(s.map.gates.map(g => [g.open, g.locked]), [[true, false], [false, false]]);
    assert.equal(p.keys, 0);
  });
  await dispose(await arena({ gates: [gate('old', 3040, y, { kind: 'gate', locked: undefined })] }), ({ s, p }) => {
    press(s, p, { interact: true });
    assert.equal(s.map.gates[0].open, false, 'a non-door gate without a lock flag is locked');
  });
});

test('a bot skips open gates; a locked gate near a rail station stops transit', async () => {
  const stations = [{ id: 'here', x: 3000, y }, { id: 'there', x: 3500, y }];
  await dispose(await arena({ gates: [gate('open', 3030, y, { open: true }), gate('shut', 3070, y)], stations, role: 'gladiator' }), ({ s, p }) => {
    p.bot = true; p.path = [{ x: 1, y: 1 }];
    const x = p.x;
    interact(s, p);
    assert.deepEqual(s.map.gates.map(g => g.open), [true, true], 'the bot opened the closed gate past the open one');
    assert.deepEqual(p.path, []);
    s.map.gates[1].open = false; s.map.gates[1].locked = true; p.bot = false;
    s.map.gates[0].open = false; s.map.gates[0].locked = true;
    interact(s, p);
    assert.deepEqual([p.x, p.y], [x, y], 'no fall through to the rail station');
    // The gates are part of the pinned map, so the player and a station pair move out of their reach instead.
    s.map.stations = [{ id: 'clear', x: 2400, y }, { id: 'far', x: 1800, y }];
    Object.assign(p, { x: 2400, railCd: 0 }); step(s);
    interact(s, p);
    assert.deepEqual([p.x, p.y], [1800, y], 'which carries them once no gate is in reach');
  });
});

test('closing a door is refused while an active body overlaps it, at each body radius', async () => {
  for (const role of ['contestant', 'gladiator']) {
    for (const closes of [true, false]) {
      const door = gate('door', 3040, y, { open: true });
      await dispose(await arena({ gates: [door] }), ({ s, p }) => {
        const other = s.players.find(q => q !== p && q.role === role), radius = actorRadius(s, other);
        // The door box spans x 3027..3053; stand the other body to its right, just clear of it or just inside.
        // The engine's own occupancy query counts touching as inside, so the clear body stands off by a hair.
        const gap = closes ? radius + 0.01 : radius - 0.01;
        Object.assign(other, { x: 3053 + gap, y, status: 'active' });
        press(s, p, { interact: true });
        assert.equal(s.map.gates[0].open, !closes, `${role} at ${gap}`);
      });
    }
  }
  await dispose(await arena({ gates: [gate('door', 3040, y, { open: true })] }), ({ s, p }) => {
    const g = s.players.find(q => q.role === 'gladiator');
    Object.assign(g, { x: 3060, y, status: 'respawning', respawnAt: s.tick + 1000 });
    press(s, p, { interact: true });
    assert.equal(s.map.gates[0].open, false, 'only active players block');
  });
});

test('respawn needs the 25-unit clearance, not the gladiator body', async () => {
  for (const [gap, returns] of [[24, false], [26, true]]) {
    const station = { id: 'st', x: 1600, y };
    await dispose(await arena({ stations: [station], obstacles: [{ id: 'crowd', x: station.x + gap, y: y - 50, w: 20, h: 100 }] }), ({ s }) => {
      const g = s.players.find(q => q.role === 'gladiator');
      assert.ok(station.x > s.hazardX + RESPAWN_HAZARD_MARGIN);
      assert.equal(canOccupy(s.map, station.x, station.y, actorRadius(s, g)), true);
      assert.equal(canOccupy(s.map, station.x, station.y, RESPAWN_CLEARANCE_RADIUS), returns);
      Object.assign(g, { status: 'respawning', respawnAt: s.tick + 1 });
      step(s);
      assert.equal(g.status, returns ? 'active' : 'respawning', `gap ${gap}`);
    });
  }
});
