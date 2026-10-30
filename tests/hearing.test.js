import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot, playerView } from '../shared/simulation.ts';
import { attack } from '../shared/simulation/combat.ts';
import { heardBy } from '../shared/simulation/hearing.ts';
import { contentById, legacyContent } from '../shared/simulation/content.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';

// Heard gunfire (#684, 14 "Heard gunfire", 15): an area, private to each hearer, with no RNG or id of its own.

const HEARING = { ticks: 80, ranges: { pistol: 1000 } };

function scene(hearing = HEARING) {
  const s = createGame(4217, undefined, hearing ? { ...legacyContent(), id: 'content-hearing-test', hearing } : legacyContent());
  const [shooter, near, far] = s.players.filter(p => p.role === 'contestant');
  const gladiator = s.players.find(p => p.role === 'gladiator');
  Object.assign(near, { x: shooter.x + 600, y: shooter.y });
  Object.assign(gladiator, { x: shooter.x - 900, y: shooter.y });
  Object.assign(far, { x: shooter.x + 1500, y: shooter.y });
  shooter.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 48 }]; shooter.selectedSlot = 0;
  return { s, shooter, near, far, gladiator };
}
const fire = (s, p) => { p.attackCd = 0; attack(s, p); };

test('content-8 is content-7 with gunfire heard', () => {
  const { id, hearing, ...eight } = contentById('content-8'), { id: seven, ...rest } = contentById('content-7');
  assert.deepEqual([id, seven, eight], ['content-8', 'content-7', rest]);
  assert.equal(hearing.ticks, 80);
  for (const weapon of Object.keys(rest.weapons)) assert.ok(hearing.ranges[weapon] > 0, weapon);
});

test('a shot is heard within range as the centre of the shooter\'s cell, by everyone but the shooter', () => {
  const { s, shooter, near, far, gladiator } = scene();
  fire(s, shooter);
  const at = cellCenter(s.map, cellIndexAt(s.map, shooter.x, shooter.y));
  for (const hearer of [near, gladiator]) assert.deepEqual(heardBy(hearer, s.tick), [{ ...at, tick: s.tick, until: s.tick + 80 }], hearer.id);
  assert.deepEqual(heardBy(far, s.tick), []);
  assert.deepEqual(heardBy(shooter, s.tick), []);
});

test('a cue fades after its ticks, and another shot from the same cell refreshes it', () => {
  const { s, shooter, near } = scene();
  fire(s, shooter);
  s.tick += 50; fire(s, shooter);
  assert.equal(heardBy(near, s.tick).length, 1);
  assert.equal(heardBy(near, s.tick)[0].tick, s.tick);
  s.tick += 79; assert.equal(heardBy(near, s.tick).length, 1);
  s.tick += 1; assert.deepEqual(heardBy(near, s.tick), []);
});

test('a silent weapon, a gladiator\'s attack and an inactive player are not heard', () => {
  const { s, shooter, near } = scene({ ticks: 80, ranges: {} });
  fire(s, shooter);
  assert.deepEqual(heardBy(near, s.tick), []);
  const loud = scene();
  fire(loud.s, loud.gladiator);
  assert.deepEqual(heardBy(loud.near, loud.s.tick), []);
  loud.near.status = 'eliminated'; fire(loud.s, loud.shooter);
  assert.deepEqual(heardBy(loud.near, loud.s.tick), []);
});

test('a cue is in its hearer\'s own projection only, and never in a snapshot', () => {
  const { s, shooter, near, gladiator } = scene();
  fire(s, shooter);
  const frame = snapshot(s);
  assert.equal(JSON.stringify(frame).includes('"heard"'), false, 'snapshots and recordings carry no cues');
  for (const viewer of [shooter, near, gladiator]) {
    const view = playerView(s, frame, viewer.id);
    for (const p of view.players) {
      if (p.id === viewer.id && viewer !== shooter) assert.equal(p.heard.length, 1, viewer.id);
      else assert.equal(p.heard, undefined, `${p.id} in ${viewer.id}'s view`);
    }
  }
  assert.equal(JSON.stringify(playerView(s, frame, 'spectator')).includes('"heard"'), false);
  s.tick += 80;
  assert.equal(playerView(s, snapshot(s), near.id).players.find(p => p.id === near.id).heard, undefined, 'a faded cue leaves the frame');
});

test('hearing changes no simulated state: frames match a match without it, tick for tick', () => {
  const silent = scene(null), loud = scene();
  let heard = 0;
  for (let tick = 0; tick < 120; tick++) {
    for (const { s, shooter } of [silent, loud]) { if (tick % 10 === 0) fire(s, shooter); step(s); }
    heard += heardBy(loud.near, loud.s.tick).length;
    assert.equal(JSON.stringify(snapshot(loud.s)), JSON.stringify(snapshot(silent.s)), `tick ${tick}`);
  }
  assert.ok(heard > 0, 'the loud match heard its shots');
});
