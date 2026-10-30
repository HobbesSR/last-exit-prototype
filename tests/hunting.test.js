import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { transitPlan } from '../shared/simulation/hunting.ts';
import { arena } from './helpers/arena.js';
import { gunfight, run, stagePhysics } from './helpers/scenario.js';

// Gladiator bots sweep regions ahead of the wall and take transit when it is quicker (#683, 14 "Gladiator bots").

test('content-11 is content-10 with gladiators sweeping and transiting', () => {
  const { id, hunting, ...eleven } = contentById('content-11'), { id: ten, ...rest } = contentById('content-10');
  assert.deepEqual([id, ten, hunting, eleven], ['content-11', 'content-10', 'sweep', rest]);
});

test('a transit is planned only when walking to a station, transiting and walking on is quicker', () => {
  const stations = [{ id: 'a', x: 600, y: 0 }, { id: 'b', x: 8000, y: 0 }, { id: 'c', x: 4000, y: 3000 }];
  const s = { map: { stations }, hazardX: -80, content: {} };
  const gladiator = (x, railCd = 0) => ({ role: 'gladiator', x, y: 0, railCd, boost: 0, stun: 0 });
  assert.deepEqual(transitPlan(s, gladiator(500), { x: 8200, y: 0 }), { from: stations[0], to: stations[1] }, 'the station nearest the goal');
  assert.equal(transitPlan(s, gladiator(500), { x: 1500, y: 0 }), null, 'a short walk is not worth it');
  assert.equal(transitPlan({ ...s, map: { stations: stations.slice(0, 2) } }, gladiator(500, 200), { x: 8200, y: 0 }), null, 'the cooldown would not be spent on arrival');
  // Station c is far enough away for the cooldown to be spent by then, and still quicker than walking.
  assert.deepEqual(transitPlan(s, gladiator(500, 200), { x: 8200, y: 0 }), { from: stations[2], to: stations[1] });
  assert.equal(transitPlan({ ...s, hazardX: 8500 }, gladiator(9000), { x: 9500, y: 0 }), null, 'stations behind the wall are not used');
});

test('a gladiator that hears a far gunfight transits to the station beside it', async () => {
  const stations = [300, 4000 - 300];
  const ten = await gunfight(4000, { content: contentById('content-10'), stations, ticks: 600 });
  const eleven = await gunfight(4000, { content: contentById('content-11'), stations, ticks: 600 });
  assert.ok(ten > 400, `walking, ${ten}`);
  assert.ok(eleven < 60, `by transit, ${eleven}`);
});

test('with no one seen and nothing heard, a gladiator sweeps the regions ahead, nearest first', async () => {
  // Five regions in a row; the gladiator starts in the first, a scripted contestant waits in a corner of the last.
  const { map } = arena({ cols: 20, rows: 3, corridor: { gaps: [1, 1, 1, 1] } });
  const { s, players: [g] } = await stagePhysics(map, { content: contentById('content-11'),
    actors: [{ role: 'gladiator', x: 300, y: 288 }, { role: 'contestant', bot: false, x: 3750, y: 60 }] });
  try {
    const centres = [1152, 1920, 2688].map(x => ({ x, y: 288 })), reached = centres.map(() => null);
    run(s, { ticks: 900, trace: s => centres.forEach((c, i) => { if (reached[i] === null && Math.hypot(g.x - c.x, g.y - c.y) < 400) reached[i] = s.tick; }) });
    assert.ok(reached.every(t => t !== null), `reached ${reached}`);
    assert.ok(reached[0] < reached[1] && reached[1] < reached[2], `in order ${reached}`);
  } finally { disposePhysics(s); }
});
