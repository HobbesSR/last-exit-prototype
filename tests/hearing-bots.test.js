import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, step, snapshot } from '../shared/simulation.ts';
import { botInput, isOpportunistic } from '../shared/simulation/bots.ts';
import { contentById } from '../shared/simulation/content.ts';
import { hearShot } from '../shared/simulation/hearing.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';
import { canOccupy } from '../shared/movement.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// Bots act on heard gunfire under `hearingResponse: 'temperament'` (#685, 14 "Heard gunfire").

// Open ground with the gladiator at its west end, a contestant far off to the east and an idle one beside it
// (an idle contestant keeps the match live). The shot is heard on the gladiator's row, 4000 east of it; the
// exit is behind the gladiator, so a patrol leads away from the shot.
const Y = 576, SHOT = { x: 4600, y: Y };
const ACTORS = [{ role: 'gladiator', x: 600, y: Y }, { role: 'contestant', x: 7800, y: 150 }, { role: 'contestant', bot: false, x: 7800, y: 1000 }];
const field = (extra = {}) => openField(8400, { exit: { x: 96, y: Y }, ...extra }).map;
const heardContent = (id, response) => ({ ...contentById(id), id: 'content-hearing-test', hearing: { ticks: 80, ranges: { pistol: 20000 } },
  ...response ? { hearingResponse: response } : {} });
async function scene(response, map = field(), content = heardContent('content-7', response)) {
  const { s, players: [gladiator, shooter] } = await stagePhysics(map, { content, actors: ACTORS });
  return { s, gladiator, shooter };
}
const away = (p, at) => Math.hypot(p.x - at.x, p.y - at.y);

test('content-9 is content-8 with bots acting on what they hear', () => {
  const { id, hearingResponse, ...nine } = contentById('content-9'), { id: eight, ...rest } = contentById('content-8');
  assert.deepEqual([id, eight, hearingResponse, nine], ['content-9', 'content-8', 'temperament', rest]);
});

test('a gladiator goes to where it heard a shot, long after the cue has faded', async () => {
  const runs = [];
  for (const response of [undefined, 'temperament']) {
    const { s, gladiator, shooter } = await scene(response);
    try {
      hearShot(s, { ...shooter, id: 'arranged', ...SHOT }, 'pistol');
      let closest = Infinity;
      for (let tick = 0; tick < 700; tick++) { step(s); closest = Math.min(closest, away(gladiator, SHOT)); }
      runs.push(closest);
    } finally { disposePhysics(s); }
  }
  // Without a response it patrols away toward the exit; with one it closes on the shot.
  assert.ok(runs[1] < runs[0] - 1500, `closest ${runs[1]} against ${runs[0]}`);
  assert.ok(runs[1] < 1200, `came within ${runs[1]}`);
});

test('content-8, which hears but does not react, plays exactly as content-7', async () => {
  const play = async id => {
    const { s, shooter } = await scene(undefined, field(), contentById(id));
    try {
      const frames = [];
      for (let tick = 0; tick < 200; tick++) {
        if (tick % 40 === 0) hearShot(s, { ...shooter, id: 'arranged', ...SHOT }, 'pistol');
        step(s); frames.push(JSON.stringify(snapshot(s)));
      }
      return frames;
    } finally { disposePhysics(s); }
  };
  assert.deepEqual(await play('content-8'), await play('content-7'));
});

test('a contestant chooses where to go from what it knows, not from geometry it has not discovered', async () => {
  // The cue's cell centre, as hearing fuzzes it; an unseen crate there must not move the contestant's goal (15, 22.6.2).
  // A cell along the shot's row whose centre is open, so only the unseen crate can make it a place not to stand.
  const bare = field(), cue = Array.from({ length: 20 }, (_, i) => cellCenter(bare, cellIndexAt(bare, SHOT.x + i * 192, SHOT.y)))
    .find(at => canOccupy(bare, at.x, at.y, 40));
  // The contestant knows nothing yet: no surveyed cell, so a crate in a cell it has not discovered is not in its plan.
  const inputs = [];
  for (const hidden of [false, true]) {
    const map = field({ obstacles: hidden ? [{ id: 'unseen', kind: 'crate', x: cue.x - 10, y: cue.y - 10, w: 20, h: 20 }] : [] });
    const { s, players: [, p, other] } = await stagePhysics(map, { content: heardContent('content-7', 'temperament'),
      actors: [{ role: 'gladiator', x: 600, y: Y }, { role: 'contestant', x: 3000, y: Y, knows: {} }, { role: 'contestant', bot: false, x: 7800, y: 1000 }] });
    try {
      assert.ok(isOpportunistic(p), 'the first contestant is the opportunistic one');
      hearShot(s, { ...other, id: 'arranged', ...cue }, 'pistol');
      const steps = [0, 1, 2].map(() => { const input = botInput(s, p); s.tick++; return input; });
      inputs.push({ steps, goal: p.route?.at(-1) });
    } finally { disposePhysics(s); }
  }
  assert.ok(inputs[0].goal, 'the contestant is heading for the shot');
  assert.deepEqual(inputs[1], inputs[0]);
});
