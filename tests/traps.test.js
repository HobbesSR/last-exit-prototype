import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, setInput, step, snapshot, playerView } from '../shared/simulation.js';

function fixture(kind, extra = {}) {
  const s = createGame(); s.map.obstacles = []; s.map.items = []; s.map.gates = [];
  for (const [i, p] of s.players.entries()) { p.bot = false; p.input = {}; p.x = 44000 + i * 1000; p.y = 1440; }
  const p = s.players[0], trap = { id: 'trap', kind, x: p.x + 40, y: p.y, homeX: p.x + 40, homeY: p.y, heading: Math.PI, cooldown: 0, offset: 0, ...extra };
  s.map.traps = [trap]; return { s, p, trap };
}
test('motion mine ignores stationary players and damages either role when triggered once', () => {
  const { s, p, trap } = fixture('mine'); const g = s.players.at(-1); g.x = trap.x + 20; g.y = trap.y;
  step(s); assert.equal(trap.spent, undefined);
  setInput(s, p.id, { seq: 1, x: 1 }); step(s);
  assert.equal(trap.spent, true); assert.equal(p.hp, 55); assert.equal(g.hp, 315);
  step(s); assert.equal(p.hp, 55);
});
test('turrets fire at either role and walls block acquisition', () => {
  const { s, p, trap } = fixture('turret');
  s.map.obstacles = [{ x: p.x + 20, y: p.y - 60, w: 4, h: 120 }];
  step(s); assert.equal(s.projectiles.length, 0);
  s.map.obstacles = []; step(s); step(s); assert.ok(p.hp < 100);
  const g = s.players.at(-1); p.status = 'eliminated'; g.x = trap.x - 45; g.y = trap.y; trap.cooldown = 0;
  step(s); step(s); assert.ok(g.hp < 360);
});
test('flamethrowers warn, fire in a cone, and respect cover', () => {
  const { s, p, trap } = fixture('flame'); s.tick = 79; step(s); assert.equal(trap.warning, true); assert.equal(p.hp, 100);
  s.tick = 119; step(s); assert.equal(trap.firing, true); assert.equal(p.hp, 94);
  s.map.obstacles = [{ x: p.x + 20, y: p.y - 60, w: 4, h: 120 }]; s.tick = 124; step(s); assert.equal(p.hp, 94);
});
test('spiders grapple either role, release targets beyond the leash, and keep target IDs private', () => {
  const { s, p, trap } = fixture('spider'); step(s); assert.equal(p.stun, 30); assert.equal(p.hp, 90);
  const view = playerView(s, snapshot(s), p.id); assert.equal(Object.hasOwn(view.traps[0], 'targetId'), false);
  p.x = trap.homeX - 500; step(s); assert.equal(trap.targetId, null);
  assert.ok(Math.hypot(trap.x - trap.homeX, trap.y - trap.homeY) <= 360);
  const g = s.players.at(-1); g.x = trap.homeX + 50; g.y = trap.homeY; trap.cooldown = 0;
  step(s); assert.equal(g.stun, 30); assert.equal(g.hp, 350);
});
