import assert from 'node:assert/strict';
import test from 'node:test';
import { HZ, disposePhysics, setInput, snapshot } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { arena } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';

// A bot in a 60-unit corridor behind a leader, or behind a crate that fills it, driven by the core's planner,
// which runs in every started game. The bot walks toward a cell at the corridor's far end.

const walls = [
  { id: 'top', x: 100, y: 100, w: 600, h: 270 },
  { id: 'bottom', x: 100, y: 430, w: 600, h: 270 },
];

async function corridor(t, { leader, props }) {
  const map = arena({ cols: 8, rows: 8, cellSize: 100, seed: 448, obstacles: walls, physicsProps: props,
    items: [{ id: 'goal-cell', kind: 'cell', charge: 0, x: 750, y: 400 }], entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 } }).map;
  const { s, players } = await stagePhysics(map, { seed: 448, content: { ...contentById('content-6'), discovery: false },
    actors: [{ role: 'contestant', x: 150, y: 400 }, ...leader ? [{ role: 'contestant', bot: false, x: 350, y: 400 }] : []] });
  t.after(() => disposePhysics(s));
  startGame(s);
  return { s, players };
}

/** Step the match, checking the bot's pose moves no faster than the motor allows and stays inside the corridor. */
function checkedStep(s, p, before) {
  stepGame(s);
  const here = now(s, p);
  const pose = snapshot(s).bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === s.players.indexOf(p));
  assert.ok(pose && Math.hypot(pose.x - here.x, pose.y - here.y) < 0.01, `gameplay and body poses agree at tick ${s.tick}`);
  assert.ok(Math.hypot(here.x - before.x, here.y - before.y) <= s.content.actorPhysics.maxSpeed / HZ + 0.02,
    `actor jumped at tick ${s.tick}: ${JSON.stringify({ before, after: { x: here.x, y: here.y } })}`);
  assert.ok(here.y >= 370 + actorRadius(s, here) - 0.6 && here.y <= 430 - actorRadius(s, here) + 0.6,
    `actor crossed corridor wall at tick ${s.tick}: y=${here.y}`);
}

test('a follower closes the gap in a 60-unit corridor and resumes when its leader moves', async t => {
  const { s, players: [follower, leader] } = await corridor(t, { leader: true });
  let closest = Infinity;
  for (let i = 0; i < 400; i++) {
    const before = { ...now(s, follower) };
    // The leader walks east to 700 and stops there, 50 short of the cell.
    assert.ok(setInput(s, leader.id, { seq: s.tick + 1, x: now(s, leader).x < 700 ? 1 : 0, y: 0 }));
    checkedStep(s, follower, before);
    if (now(s, leader).x >= 695) closest = Math.min(closest, now(s, leader).x - now(s, follower).x);
  }
  const contact = actorRadius(s, now(s, follower)) + actorRadius(s, now(s, leader)) + 2;
  assert.ok(closest <= contact + 5, `follower stayed too far behind: closest ${closest}, contact ${contact}`);
  assert.ok(now(s, follower).x < now(s, leader).x - 15, 'follower did not tunnel through leader');
  const beforeResume = now(s, follower).x;
  for (let i = 0; i < 40; i++) {
    const before = { ...now(s, follower) };
    assert.ok(setInput(s, leader.id, { seq: s.tick + 1, x: 1, y: 0 }));
    checkedStep(s, follower, before);
  }
  assert.ok(now(s, follower).x > beforeResume + 10, `follower did not resume: ${beforeResume} -> ${now(s, follower).x}`);
});

test('the motor pushes a corridor-filling crate forward without tunneling or teleporting', async t => {
  const { s, players: [p] } = await corridor(t, { props: [{ id: 'crate', profile: 'crate', x: 350, y: 400, angle: Math.PI / 2 }] });
  const prop = () => snapshot(s).bodies.find(b => b.owner.kind === 'prop');
  const startCrate = prop().x;
  for (let i = 0; i < 400 && now(s, p).x < 650; i++) {
    checkedStep(s, p, { ...now(s, p) });
    const crate = prop();
    const verticalExtent = Math.abs(Math.sin(crate.angle)) * 24 + Math.abs(Math.cos(crate.angle)) * 12;
    assert.ok(crate.y - verticalExtent >= 370 - 0.6 && crate.y + verticalExtent <= 430 + 0.6,
      `crate crossed corridor wall at tick ${s.tick}: pose=${JSON.stringify(crate)}`);
  }
  assert.ok(prop().x > startCrate + 100, `crate was not pushed: ${startCrate} -> ${prop().x}`);
  assert.ok(now(s, p).x >= 650, `actor did not reach x=650 after pushing: ${now(s, p).x}`);
});
