import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, snapshot } from '../shared/simulation.ts';
import { botInput, isOpportunistic } from '../shared/simulation/bots.ts';
import { generateMap } from '../shared/map/generate.ts';
import { contentById, legacyContent } from '../shared/simulation/content.ts';
import { hearShot } from '../shared/simulation/hearing.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';
import { canOccupy } from '../shared/movement.ts';

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

test('a contestant chooses where to go from what it knows, not from geometry it has not discovered', () => {
  // The cue's cell centre, as hearing fuzzes it; an unseen crate there must not move the contestant's goal (15, 22.6.2).
  const inputs = [false, true].map(hidden => {
    // A cell along the shot's row whose centre is open, so only the unseen crate can make it a place not to stand.
    const map = generateMap(4217), cue = Array.from({ length: 20 }, (_, i) => cellCenter(map, cellIndexAt(map, SHOT.x + i * 192, SHOT.y)))
      .find(at => canOccupy(map, at.x, at.y, 40));
    if (hidden) map.obstacles.push({ id: 'unseen', kind: 'crate', x: cue.x - 10, y: cue.y - 10, w: 20, h: 20 });
    const s = createGame(4217, map, { ...legacyContent(), id: 'content-hearing-test', hearing: { ticks: 80, ranges: { pistol: 20000 } }, hearingResponse: 'temperament' });
    const p = s.players.find(q => q.role === 'contestant' && isOpportunistic(q));
    for (const known of [p.discovery.discovered, p.discovery.surveyed, p.discovery.seen]) known?.clear();
    p.discovery.items?.clear();
    hearShot(s, { ...s.players.find(q => q.role === 'contestant' && q !== p), id: 'arranged', ...cue }, 'pistol');
    const steps = [0, 1, 2].map(() => { const input = botInput(s, p); s.tick++; return input; });
    return { steps, goal: p.route?.at(-1) };
  });
  assert.ok(inputs[0].goal, 'the contestant is heading for the shot');
  assert.deepEqual(inputs[1], inputs[0]);
});
