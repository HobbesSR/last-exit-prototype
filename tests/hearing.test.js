import { renderedPlayerView as playerView } from './helpers/relational.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, setInput, step, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';
import { openField } from './helpers/arena.js';
import { hears, run, stagePhysics } from './helpers/scenario.js';
import { identifyItems } from './helpers/item-identity.js';

// Heard gunfire (#684, 14 "Heard gunfire", 15): an area, private to each hearer, with no RNG or id of its own.

const HEARING = { ticks: 80, ranges: { pistol: 1000 } };

// The shooter stands in the middle of open ground with a listener 600 east, a gladiator 900 west and a
// contestant 1500 east. Without `hearing` it is the shipped content-7 as it stands.
async function scene(hearing = HEARING) {
  const base = contentById('content-7'), y = 600, x = 1200;
  const { map } = openField(3600);
  const { s, players: [shooter, near, far, gladiator] } = await stagePhysics(map, { content: hearing ? { ...base, id: 'content-hearing-test', hearing } : base,
    actors: [
      { role: 'contestant', bot: false, x, y },
      { role: 'contestant', bot: false, x: x + 600, y },
      { role: 'contestant', bot: false, x: x + 1500, y },
      { role: 'gladiator', bot: false, x: x - 900, y },
    ] });
  shooter.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 48, instanceId: 'pistol', lineageId: 'pistol' }]; shooter.selectedSlot = 0;
  identifyItems(s);
  return { s, shooter, near, far, gladiator };
}
const seqs = new WeakMap();
const fire = (s, p) => {
  let map = seqs.get(s);
  if (!map) seqs.set(s, map = new Map());
  const next = (map.get(p.id) ?? 0) + 1;
  map.set(p.id, next);
  assert.ok(setInput(s, p.id, { seq: next, attack: true, aim: 0 }));
  step(s);
};

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
    for (const hearer of [near, gladiator]) assert.deepEqual(hears(s, hearer), [{ ...at, tick: s.tick, until: s.tick + 80 }], hearer.id);
    assert.deepEqual(hears(s, far), []);
    assert.deepEqual(hears(s, shooter), []);
  } finally { disposePhysics(s); }
});

test('a cue fades after its ticks, and another shot from the same cell refreshes it', async () => {
  const { s, shooter, near } = await scene();
  try {
    fire(s, shooter);
    run(s, { ticks: 50 }); fire(s, shooter);
    assert.equal(hears(s, near).length, 1);
    assert.equal(hears(s, near)[0].tick, s.tick);
    run(s, { ticks: 79 }); assert.equal(hears(s, near).length, 1);
    run(s, { ticks: 1 }); assert.deepEqual(hears(s, near), []);
  } finally { disposePhysics(s); }
});

test("a silent weapon, a gladiator's attack and an inactive player are not heard", async () => {
  const quiet = await scene({ ticks: 80, ranges: {} }), loud = await scene(), eliminated = await scene();
  try {
    fire(quiet.s, quiet.shooter);
    assert.deepEqual(hears(quiet.s, quiet.near), []);
    fire(loud.s, loud.gladiator);
    assert.deepEqual(hears(loud.s, loud.near), []);
    eliminated.near.status = 'eliminated';
    fire(eliminated.s, eliminated.shooter);
    assert.deepEqual(hears(eliminated.s, eliminated.near), []);
  } finally { disposePhysics(quiet.s); disposePhysics(loud.s); disposePhysics(eliminated.s); }
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
    run(s, { ticks: 80 });
    assert.equal(playerView(s, snapshot(s), near.id).players.find(p => p.id === near.id).heard, undefined, 'a faded cue leaves the frame');
  } finally { disposePhysics(s); }
});

test('hearing changes no simulated state: frames match a match without it, tick for tick', async () => {
  const silent = await scene(null), loud = await scene();
  try {
    for (const { s } of [silent, loud]) { s.players.forEach(p => { p.bot = false; }); identifyItems(s); }
    let heard = 0;
    for (let tick = 0; tick < 120; tick++) {
      for (const { s, shooter } of [silent, loud]) {
        if (tick % 10 === 0) assert.ok(setInput(s, shooter.id, { seq: tick + 1, attack: true, aim: 0 }));
        step(s);
      }
      heard += hears(loud.s, loud.near).length;
      assert.equal(JSON.stringify(snapshot(loud.s)), JSON.stringify(snapshot(silent.s)), `tick ${tick}`);
    }
    assert.ok(heard > 0, 'the loud match heard its shots');
  } finally { disposePhysics(silent.s); disposePhysics(loud.s); }
});
