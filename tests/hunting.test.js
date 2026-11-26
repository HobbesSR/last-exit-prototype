import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';
import { gunfight, now, run, stagePhysics } from './helpers/scenario.js';

// Gladiator bots sweep regions ahead of the wall and take transit when it is quicker (#683, #681, 14 "Gladiator bots").
// Unit-level hunting heuristics are held in rust/core/src/tick/bots/hunting.rs.

test('content-11 is content-10 with gladiators sweeping and transiting', () => {
  const { id, hunting, ...eleven } = contentById('content-11'), { id: ten, ...rest } = contentById('content-10');
  assert.deepEqual([id, ten, hunting, eleven], ['content-11', 'content-10', 'sweep', rest]);
});

test('content-12 is content-11 with front-estimated coarse sweeping, repulsion and exit goalkeeping', () => {
  const { id, hunting, ...twelve } = contentById('content-12'), { id: eleven, hunting: _, ...rest } = contentById('content-11');
  assert.deepEqual([id, eleven, hunting, twelve], ['content-12', 'content-11', 'front', rest]);
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
    run(s, { ticks: 900, trace: s => centres.forEach((c, i) => { if (reached[i] === null && Math.hypot(now(s, g).x - c.x, now(s, g).y - c.y) < 400) reached[i] = s.tick; }) });
    assert.ok(reached.every(t => t !== null), `reached ${reached}`);
    assert.ok(reached[0] < reached[1] && reached[1] < reached[2], `in order ${reached}`);
  } finally { disposePhysics(s); }
});

test('bot-match under content-12 runs cleanly and uses transit', async () => {
  const { map } = arena({ cols: 30, rows: 6, corridor: { gaps: [2, 2, 2, 2] },
    stations: [{ id: 'st0', nodeId: 'n0', x: 300, y: 576 }, { id: 'st1', nodeId: 'n1', x: 5000, y: 576 }] });
  const actors = [
    { role: 'gladiator', x: 5050, y: 576 },
    { role: 'contestant', bot: true, x: 1500, y: 576 },
  ];
  const { s, players: [g] } = await stagePhysics(map, {
    content: contentById('content-12'),
    actors,
  });
  try {
    let usedTransit = false;
    run(s, { ticks: 120, trace: s => { if (now(s, g).status === 'transit' || now(s, g).railCd > 0) usedTransit = true; } });
    assert.equal(s.tick, 120, 'ran 120 ticks cleanly');
    assert.ok(usedTransit, 'gladiator at exit planned and used transit toward the front');
  } finally { disposePhysics(s); }
});
