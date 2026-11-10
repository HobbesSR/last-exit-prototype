import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, step, snapshot, playerView } from '../shared/simulation.ts';
import { attack } from '../shared/simulation/combat.ts';
import { heardBy } from '../shared/simulation/hearing.ts';
import { contentById } from '../shared/simulation/content.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// Heard gunfire (#684, 14 "Heard gunfire", 15): an area, private to each hearer, with no RNG or id of its own.

const HEARING = { ticks: 80, ranges: { pistol: 1000 } };

// The shooter stands in the middle of open ground with a listener 600 east, a gladiator 900 west and a
// contestant 1500 east. Without `hearing` it is the shipped content-7 as it stands.
async function scene(hearing = HEARING) {
  const base = contentById('content-7'), y = 576, x = 1200;
  const { map } = openField(3600);
  const { s, players: [shooter, near, far, gladiator] } = await stagePhysics(map, { content: hearing ? { ...base, id: 'content-hearing-test', hearing } : base,
    actors: [{ role: 'contestant', x, y }, { role: 'contestant', x: x + 600, y }, { role: 'contestant', x: x + 1500, y }, { role: 'gladiator', x: x - 900, y }] });
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

test("a shot is heard within range as the centre of the shooter's cell, by everyone but the shooter", async () => {
  const { s, shooter, near, far, gladiator } = await scene();
  try {
    fire(s, shooter);
    const at = cellCenter(s.map, cellIndexAt(s.map, shooter.x, shooter.y));
    for (const hearer of [near, gladiator]) assert.deepEqual(heardBy(hearer, s.tick), [{ ...at, tick: s.tick, until: s.tick + 80 }], hearer.id);
    assert.deepEqual(heardBy(far, s.tick), []);
    assert.deepEqual(heardBy(shooter, s.tick), []);
  } finally { disposePhysics(s); }
});

test('a cue fades after its ticks, and another shot from the same cell refreshes it', async () => {
  const { s, shooter, near } = await scene();
  try {
    fire(s, shooter);
    s.tick += 50; fire(s, shooter);
    assert.equal(heardBy(near, s.tick).length, 1);
    assert.equal(heardBy(near, s.tick)[0].tick, s.tick);
    s.tick += 79; assert.equal(heardBy(near, s.tick).length, 1);
    s.tick += 1; assert.deepEqual(heardBy(near, s.tick), []);
  } finally { disposePhysics(s); }
});

test("a silent weapon, a gladiator's attack and an inactive player are not heard", async () => {
  const quiet = await scene({ ticks: 80, ranges: {} }), loud = await scene();
  try {
    fire(quiet.s, quiet.shooter);
    assert.deepEqual(heardBy(quiet.near, quiet.s.tick), []);
    fire(loud.s, loud.gladiator);
    assert.deepEqual(heardBy(loud.near, loud.s.tick), []);
    loud.near.status = 'eliminated'; fire(loud.s, loud.shooter);
    assert.deepEqual(heardBy(loud.near, loud.s.tick), []);
  } finally { disposePhysics(quiet.s); disposePhysics(loud.s); }
});

test("a cue is in its hearer's own projection only, and never in a snapshot", async () => {
  const { s, shooter, near, gladiator } = await scene();
  try {
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
  } finally { disposePhysics(s); }
});

test('hearing changes no simulated state: frames match a match without it, tick for tick', async () => {
  const silent = await scene(null), loud = await scene();
  try {
    let heard = 0;
    for (let tick = 0; tick < 120; tick++) {
      for (const { s, shooter } of [silent, loud]) { if (tick % 10 === 0) fire(s, shooter); step(s); }
      heard += heardBy(loud.near, loud.s.tick).length;
      assert.equal(JSON.stringify(snapshot(loud.s)), JSON.stringify(snapshot(silent.s)), `tick ${tick}`);
    }
    assert.ok(heard > 0, 'the loud match heard its shots');
  } finally { disposePhysics(silent.s); disposePhysics(loud.s); }
});
