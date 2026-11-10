import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

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
  return { s, p, g, trap: s.map.traps[0] };
}

test('motion mine ignores stationary players and damages either role when triggered once', async () => {
  const { s, p, g, trap } = await fixture('mine');
  try {
    g.x = trap.x + 30; g.y = trap.y;
    step(s); assert.equal(trap.spent, undefined);
    const hp = { p: p.hp + p.shield, g: g.hp + g.shield };
    setInput(s, p.id, { seq: 1, x: 1 }); step(s);
    assert.equal(trap.spent, true);
    assert.ok(p.hp + p.shield < hp.p, 'the contestant is hurt'); assert.ok(g.hp + g.shield < hp.g, 'so is the gladiator');
    const after = p.hp; step(s); assert.equal(p.hp, after, 'a spent mine does nothing more');
  } finally { disposePhysics(s); }
});

test('turrets fire at either role and walls block acquisition', async () => {
  const covered = await fixture('turret', { cover: true });
  try {
    for (let i = 0; i < 3; i++) step(covered.s);
    assert.equal(covered.s.projectiles.length, 0, 'no shot through the wall');
    assert.equal(covered.p.hp, 100);
  } finally { disposePhysics(covered.s); }
  const { s, p, g, trap } = await fixture('turret');
  try {
    for (let i = 0; i < 3; i++) step(s);
    assert.ok(p.hp < 100, 'the contestant is shot');
    p.status = 'eliminated'; g.x = trap.x - 45; g.y = trap.y; trap.cooldown = 0;
    const before = g.hp;
    for (let i = 0; i < 3; i++) step(s);
    assert.ok(g.hp < before, 'so is a gladiator');
  } finally { disposePhysics(s); }
});

test('flamethrowers warn, fire in a cone, and respect cover', async () => {
  const { s, p, trap } = await fixture('flame');
  try {
    s.tick = 79; step(s); assert.equal(trap.warning, true); assert.equal(p.hp, 100);
    s.tick = 119; step(s); assert.equal(trap.firing, true); assert.ok(p.hp < 100, 'the cone burns');
  } finally { disposePhysics(s); }
  const covered = await fixture('flame', { cover: true });
  try {
    covered.s.tick = 119; step(covered.s); assert.equal(covered.trap.firing, true);
    assert.equal(covered.p.hp, 100, 'not through cover');
  } finally { disposePhysics(covered.s); }
});

test('spiders grapple either role, release targets beyond the leash, and keep target IDs private', async () => {
  const { s, p, g, trap } = await fixture('spider');
  try {
    step(s); assert.ok(p.stun > 0, 'grappled'); assert.ok(p.hp < 100);
    const view = playerView(s, snapshot(s), p.id); assert.equal(Object.hasOwn(view.traps[0], 'targetId'), false);
    p.x = trap.homeX - 500; step(s); assert.equal(trap.targetId, null);
    assert.ok(Math.hypot(trap.x - trap.homeX, trap.y - trap.homeY) <= 360);
    g.x = trap.homeX + 50; g.y = trap.homeY; trap.cooldown = 0;
    const before = g.hp;
    step(s); assert.ok(g.stun > 0); assert.ok(g.hp < before);
  } finally { disposePhysics(s); }
});
