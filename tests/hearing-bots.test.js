import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, setInput, step, snapshot } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { cellCenter, cellIndexAt } from '../shared/discovery.ts';
import { canOccupy } from '../shared/movement.ts';
import { openField } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';
import { identifyItems } from './helpers/item-identity.js';

// Bots act on heard gunfire under `hearingResponse: 'temperament'` (#685, 14 "Heard gunfire").

// Open ground with the gladiator at its west end, a contestant far off to the east and an idle one beside it
// (an idle contestant keeps the match live). The shot is heard on the gladiator's row, 4000 east of it; the
// exit is behind the gladiator, so a patrol leads away from the shot.
const Y = 576, SHOT = { x: 4600, y: Y };
const ACTORS = [{ role: 'gladiator', x: 600, y: Y }, { role: 'contestant', bot: false, ...SHOT }, { role: 'contestant', bot: false, x: 7800, y: 1000 }];
const field = (extra = {}) => openField(8400, { exit: { x: 96, y: Y }, ...extra }).map;
const heardContent = (id, response) => ({ ...contentById(id), id: 'content-hearing-test', hearing: { ticks: 80, ranges: { pistol: 20000 } },
  ...response ? { hearingResponse: response } : {} });
async function scene(response, map = field(), content = heardContent('content-7', response)) {
  const { s, players: [gladiator, shooter] } = await stagePhysics(map, { content, actors: ACTORS });
  shooter.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48,
    instanceId: 'hearing-weapon', lineageId: 'hearing-weapon' };
  identifyItems(s);
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
      assert.ok(setInput(s, shooter.id, { seq: 1, attack: true, aim: 0 }));
      let closest = Infinity;
      for (let tick = 0; tick < 700; tick++) { step(s); closest = Math.min(closest, away(now(s, gladiator), SHOT)); }
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
        if (tick % 40 === 0) assert.ok(setInput(s, shooter.id, { seq: tick + 1, attack: true, aim: 0 }));
        step(s); frames.push(JSON.stringify(snapshot(s)));
      }
      return frames;
    } finally { disposePhysics(s); }
  };
  assert.deepEqual(await play('content-8'), await play('content-7'));
});

test('a contestant chooses where to go from what it knows, not from geometry it has not discovered', async t => {
  // A crate where the listener plans to stand must not move a contestant's goal, which knows nothing yet: no surveyed
  // cell, so geometry it has not discovered is not in its plan (15, 22.6.2). A gladiator knows the map, so it does move
  // its goal: the control. Each match hears the same shot.
  const play = async (role, crate) => {
    const map = field({ obstacles: crate ? [{ id: 'unseen', kind: 'crate', x: crate.x - 10, y: crate.y - 10, w: 20, h: 20 }] : [] });
    const { s, players: [bot, shooter] } = await stagePhysics(map, { content: heardContent('content-7', 'temperament'),
      actors: [{ role, x: 3000, y: Y, ...role === 'contestant' && { knows: {} } }, { role: 'contestant', bot: false, ...SHOT }, { role: 'contestant', bot: false, x: 7800, y: 1000 }] });
    t.after(() => disposePhysics(s));
    shooter.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48, instanceId: 'hearing-weapon', lineageId: 'hearing-weapon' };
    identifyItems(s);
    const { match } = startGame(s), actor = match.ids.actorOfPlayer.get(bot.id), steps = [];
    assert.ok(setInput(s, shooter.id, { seq: 1, attack: true, aim: 0 }));
    for (let i = 0; i < 60; i++) {
      const { input } = stepGame(s).inbound.find(row => row.type === 'command' && row.command.source === 'bot' && row.command.actor === actor).command;
      steps.push({ movement: input.movement, goal: match.botRoute(bot.id).at(-1) });
    }
    return steps;
  };
  const clear = await play('contestant'), goal = clear.at(-1).goal;
  assert.ok(goal && Math.hypot(goal.x - SHOT.x, goal.y - SHOT.y) < 400, 'the contestant is heading for the shot');
  assert.deepEqual(await play('contestant', goal), clear, 'a crate it has not seen changes nothing it plans');
  assert.notDeepEqual(await play('gladiator', goal), await play('gladiator'), 'one a gladiator knows of does');
});
