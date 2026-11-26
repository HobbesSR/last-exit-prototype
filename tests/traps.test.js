import { startGame } from '../shared/simulation/tick.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, setInput, stateOf, step, snapshot, playerView } from '../shared/simulation.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { openField } from './helpers/arena.js';
import { now, stagePhysics } from './helpers/scenario.js';

// Traps on the shipped content and its engine (#920): a contestant beside one trap on open ground, a
// gladiator far off, all played by the test. A second contestant stands far off too, so the match goes on
// when the first is eliminated. Cover is part of the map, which the engine pins at creation.
const at = { x: 600, y: 576 };
async function fixture(kind, { extra = {}, cover = false } = {}) {
  const trap = { id: 'trap', kind, x: at.x + 40, y: at.y, homeX: at.x + 40, homeY: at.y, heading: Math.PI, cooldown: 0, offset: 0, ...extra };
  const obstacles = cover ? [{ id: 'cover', x: at.x + 20, y: at.y - 60, w: 4, h: 120 }] : [];
  const { map } = openField(3000, { traps: [trap], obstacles });
  const { s, players: [p, g] } = await stagePhysics(map, { content: defaultContent(),
    actors: [{ role: 'contestant', bot: false, ...at }, { role: 'gladiator', bot: false, x: 2400, y: at.y },
      { role: 'contestant', bot: false, x: 2400, y: 150 }] });
  for (const q of s.players) q.input = {};
  return { s, p, g, trap: s.traps[0] };
}

test('motion mine ignores stationary players and damages either role when triggered once', async () => {
  const { s, p, g, trap } = await fixture('mine');
  try {
    // The trap's placement is the start's; whether it has gone off is the core's.
    const spent = () => stateOf(s).traps[0].spent, life = q => now(s, q).hp + now(s, q).shield;
    g.x = trap.x + 30; g.y = trap.y;
    step(s); assert.equal(spent(), false);
    const hp = { p: life(p), g: life(g) };
    setInput(s, p.id, { seq: 1, x: 1 }); step(s);
    assert.equal(spent(), true);
    assert.ok(life(p) < hp.p, 'the contestant is hurt'); assert.ok(life(g) < hp.g, 'so is the gladiator');
    const after = now(s, p).hp; step(s); assert.equal(now(s, p).hp, after, 'a spent mine does nothing more');
  } finally { disposePhysics(s); }
});

test('a turret exposes its aim and shot in the committed frame', async () => {
  const { s } = await fixture('turret');
  try {
    step(s);
    const frame = snapshot(s);
    assert.equal(frame.traps[0].aiming, true);
    assert.equal(frame.projectiles.length, 1);
    assert.ok(frame.projectiles[0].dx < 0, 'the shot travels toward the contestant');
  } finally { disposePhysics(s); }
});

test('a flame trap exposes warning and firing states in committed frames', async () => {
  const { s, p } = await fixture('flame', { extra: { offset: 115 } });
  try {
    step(s);
    let trap = snapshot(s).traps[0];
    assert.deepEqual([trap.warning, trap.firing], [true, false]);
    for (let i = 0; i < 4; i++) step(s);
    trap = snapshot(s).traps[0];
    assert.deepEqual([trap.warning, trap.firing], [false, true]);
    assert.ok(now(s, p).hp + now(s, p).shield < 100, 'the firing cone damaged the contestant');
  } finally { disposePhysics(s); }
});

test('spiders grapple either role, release targets beyond the leash, and keep target IDs private', async () => {
  const { s, p, g, trap } = await fixture('spider');
  try {
    step(s); assert.ok(now(s, p).stun > 0, 'grappled'); assert.ok(now(s, p).hp < 100);
    const view = playerView(s, snapshot(s), p.id); assert.equal(Object.hasOwn(view.traps[0], 'targetId'), false);
    assert.ok(startGame(s).boundary.teleport(p.id, [trap.homeX - 500, now(s, p).y]));
    step(s); assert.equal(stateOf(s).traps[0].targetId, null);
    const crawled = stateOf(s).traps[0];
    assert.ok(Math.hypot(crawled.x - trap.homeX, crawled.y - trap.homeY) <= 360);
    assert.ok(startGame(s).boundary.teleport(g.id, [trap.homeX + 50, trap.homeY]));
    const before = now(s, g).hp;
    for (let i = 0; i <= s.content.traps.spider.cooldown; i++) step(s);
    assert.ok(now(s, g).stun > 0); assert.ok(now(s, g).hp < before);
  } finally { disposePhysics(s); }
});
