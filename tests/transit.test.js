import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, setInput, step } from '../shared/simulation.ts';
import { contentById, legacyContent } from '../shared/simulation/content.ts';
import { queueInput, consumeInput } from '../shared/simulation/input.ts';
import { transitOptions } from '../shared/simulation/transit.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { openField } from './helpers/arena.js';
import { stage, stagePhysics } from './helpers/scenario.js';

// Gladiators choose their transit destination (#692, 12 "Transit route selection", 14).

const STATIONS = [500, 2000, 3500, 5000].map((x, i) => ({ id: `st${i}`, nodeId: `n${i}`, x, y: 576 }));
const SELECTABLE = { ...legacyContent(), id: 'content-transit-test', transit: 'selectable' };

// An idle contestant keeps the match live: one without any ends on its first tick.
const ACTORS = [{ role: 'gladiator', bot: false, x: 500, y: 576 }, { role: 'contestant', bot: false, x: 5400, y: 150 }];

/** A gladiator standing on the first of four stations along open ground, played by a person. */
function scene(content = SELECTABLE) {
  const { map } = openField(5600, { stations: structuredClone(STATIONS) });
  const { s, players: [g] } = stage(map, { content, actors: ACTORS });
  let seq = 0;
  const send = input => { setInput(s, g.id, { seq: ++seq, ...input }); step(s); };
  return { s, g, send };
}
const rails = s => s.effects.filter(e => e.kind === 'rail').length;

test('content-10 is content-9 with selectable transit, tuned to be instant', () => {
  const { id, transit, transitTime, ...ten } = contentById('content-10'), { id: nine, ...rest } = contentById('content-9');
  assert.deepEqual([id, nine, transit, transitTime, ten], ['content-10', 'content-9', 'selectable', { base: 0, perUnit: 0 }, rest]);
});

test('a gladiator may transit to any station ahead, by name', () => {
  const { s, g, send } = scene();
  assert.deepEqual(transitOptions(s, g).ahead.map(st => st.id), ['st1', 'st2', 'st3']);
  assert.equal(transitOptions(s, g).next.id, 'st1');
  send({ transit: 'st3' });
  assert.deepEqual([g.x, g.y, g.railCd, g.status, rails(s)], [5000, 576, 180, 'active', 2]);
});

test('plain interact still goes to the next station ahead', () => {
  for (const content of [SELECTABLE, legacyContent()]) {
    const { g, send } = scene(content);
    send({ interact: true });
    assert.deepEqual([g.x, g.railCd], [2000, 180], content.id);
  }
});

test('an unknown, current or behind-the-wall station, or a spent cooldown, is refused with no effect', () => {
  for (const [name, choice, arrange] of [['unknown', 'nowhere'], ['current', 'st0'], ['behind the wall', 'st1', s => {
      // The wall follows the clock: run it to where the wall stands past the second station.
      const { hazardGraceTicks: grace, durationTicks: duration } = s.content;
      s.tick = grace + Math.ceil(2180 / (s.map.width + 100) * (duration - grace));
    }],
    ['cooling down', 'st2', (s, g) => { g.railCd = 30; }]]) {
    const { s, g, send } = scene();
    arrange?.(s, g);
    const cooldown = g.railCd;
    send({ transit: choice });
    assert.deepEqual([g.x, g.y, g.railCd, rails(s)], [500, 576, Math.max(0, cooldown - 1), 0], name);
  }
});

test('without selectable transit the choice is ignored', () => {
  const { g, send } = scene(legacyContent());
  send({ transit: 'st3' });
  assert.deepEqual([g.x, g.railCd], [500, 0]);
});

test('with a travel time the gladiator is out of the world until it lands, and the cooldown starts there', () => {
  // 20 ticks plus one per 100 units: 45 more for the 4,500-unit trip.
  const { s, g, send } = scene({ ...SELECTABLE, transitTime: { base: 20, perUnit: 0.01 } });
  send({ transit: 'st3' });
  const left = s.tick;
  assert.deepEqual([g.status, g.transit, g.railCd, rails(s)], ['transit', { to: 'st3', arriveAt: left + 65 }, 0, 1]);
  for (let i = 0; i < 100 && g.status === 'transit'; i++) { send({ transit: 'st2', interact: true }); assert.ok(s.tick <= left + 65, 'lands on time'); }
  assert.deepEqual([s.tick, g.x, g.y, g.railCd, g.transit], [left + 65, 5000, 576, 179, undefined]);
  assert.ok(s.effects.some(e => e.kind === 'rail' && e.x === 5000), 'the rail effect marks the landing');
});

test('the transit input is bounded, sent once, and never repeated by a starved queue', () => {
  const p = { id: 'g0', input: {}, lastSeq: -1 };
  assert.equal(queueInput(p, { seq: 1, transit: 'st3' }, 0).transit, 'st3');
  assert.equal('transit' in queueInput(p, { seq: 2, transit: 'x'.repeat(65) }, 0), false);
  assert.equal('transit' in queueInput(p, { seq: 3, transit: 7 }, 0), false);
  assert.equal('transit' in queueInput(p, { seq: 4 }, 0), false, 'absent unless sent');
  for (let i = 0; i < 4; i++) consumeInput(p, 0);
  assert.equal(consumeInput(p, 1).transit, undefined);
});

test('on the physics engine the body leaves on departure and is placed on landing', async () => {
  const { map } = openField(5600, { stations: structuredClone(STATIONS) });
  const content = { ...contentById('content-10'), transitTime: { base: 10, perUnit: 0 } };
  const { s, players: [g] } = await stagePhysics(map, { content, actors: ACTORS });
  try {
    const body = () => physicsRuntime(s).world.getTransform(`actor:${g.id}`);
    setInput(s, g.id, { seq: 1, transit: 'st2' }); step(s);
    assert.equal(g.status, 'transit');
    step(s);
    assert.equal(body(), undefined, 'no body in transit');
    for (let i = 0; i < 10 && g.status === 'transit'; i++) step(s);
    assert.equal(g.status, 'active');
    assert.ok(Math.hypot(body().x - 3500, body().y - 576) < 100, `landed at ${body().x},${body().y}`);
  } finally { disposePhysics(s); }
});
