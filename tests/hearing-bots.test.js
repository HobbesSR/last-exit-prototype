import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot } from '../shared/simulation.ts';
import { contentById, legacyContent } from '../shared/simulation/content.ts';
import { hearShot } from '../shared/simulation/hearing.ts';

// Bots act on heard gunfire under `hearingResponse: 'temperament'` (#685, 14 "Heard gunfire").

const SHOT = { x: 12000, y: 3200 };
function scene(response) {
  const s = createGame(4217, undefined, { ...legacyContent(), id: 'content-hearing-test', hearing: { ticks: 80, ranges: { pistol: 20000 } },
    ...response ? { hearingResponse: response } : {} });
  const shooter = s.players.find(p => p.role === 'contestant');
  return { s, gladiator: s.players.find(p => p.role === 'gladiator'), shooter };
}
const away = (p, at) => Math.hypot(p.x - at.x, p.y - at.y);

test('content-9 is content-8 with bots acting on what they hear', () => {
  const { id, hearingResponse, ...nine } = contentById('content-9'), { id: eight, ...rest } = contentById('content-8');
  assert.deepEqual([id, eight, hearingResponse, nine], ['content-9', 'content-8', 'temperament', rest]);
});

test('a gladiator goes to where it heard a shot, long after the cue has faded', () => {
  const runs = [undefined, 'temperament'].map(response => {
    const { s, gladiator, shooter } = scene(response);
    hearShot(s, { ...shooter, id: 'arranged', ...SHOT }, 'pistol');
    let closest = Infinity;
    for (let tick = 0; tick < 700; tick++) { step(s); closest = Math.min(closest, away(gladiator, SHOT)); }
    return closest;
  });
  // Without a response it patrols toward a station that passes some way off; with one it closes on the shot.
  assert.ok(runs[1] < runs[0] - 1500, `closest ${runs[1]} against ${runs[0]}`);
  assert.ok(runs[1] < 1200, `came within ${runs[1]}`);
});

test('content-8, which hears but does not react, plays exactly as content-7', () => {
  const play = id => {
    const s = createGame(4217, undefined, { ...contentById(id), actorPhysics: undefined, worldPhysics: undefined, hook: undefined, itemInstances: undefined, dynamicNavigation: undefined });
    const shooter = s.players.find(p => p.role === 'contestant');
    const frames = [];
    for (let tick = 0; tick < 200; tick++) {
      if (tick % 40 === 0) hearShot(s, { ...shooter, id: 'arranged', ...SHOT }, 'pistol');
      step(s); frames.push(JSON.stringify(snapshot(s)));
    }
    return frames;
  };
  assert.deepEqual(play('content-8'), play('content-7'));
});
