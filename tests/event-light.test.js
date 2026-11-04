import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVENT_LIGHT, EVENT_LIGHT_TINTS, resolveEventLights, drawEventLights, eventLightAt, liftByEventLight } from '../public/event-light.js';
import { G } from '../public/palette.js';

const frame = () => ({
  effects: [
    { id: 1, kind: 'shock', x: 100, y: 100, radius: 130, life: 12 },
    { id: 2, kind: 'loot', x: 300, y: 100, radius: 30, life: 12 },
    { id: 3, kind: 'scan', x: 500, y: 100, radius: 450, life: 6 },
  ],
  projectiles: [{ id: 4, x: 200, y: 200, dx: 10, dy: 0 }],
  traps: [
    { id: 'flame-a', kind: 'flame', x: 400, y: 400, heading: 0, firing: true },
    { id: 'flame-b', kind: 'flame', x: 600, y: 400, heading: 0, warning: true, firing: false },
    { id: 'mine', kind: 'mine', x: 700, y: 400 },
  ],
});

test('combat and arena events light their surroundings; pickups and idle traps do not (#594)', () => {
  const lights = resolveEventLights(frame());
  assert.deepEqual(lights.map(l => l.id).sort(), ['fx:1', 'fx:3', 'shot:4', 'trap:flame-a']);
  for (const light of lights) {
    assert.ok(light.radius > 0 && light.radius <= EVENT_LIGHT.radius, `${light.id} radius is bounded`);
    assert.ok(light.strength > 0 && light.strength <= EVENT_LIGHT.peak, `${light.id} strength is bounded`);
  }
  // A wide scan is capped rather than flooding the screen.
  assert.equal(lights.find(l => l.id === 'fx:3').radius, EVENT_LIGHT.radius);
});

test('an event the viewer cannot see lights nothing, even where its glow would reach seen ground (#594, 29.4)', () => {
  // The shock's centre is hidden; everything around it is visible.
  const lit = (x, y) => !(x === 100 && y === 100);
  const lights = resolveEventLights(frame(), { lit });
  assert.equal(lights.some(l => l.id === 'fx:1'), false);
  // A flame trap is judged at its nozzle, not where its glow lands.
  const hiddenNozzle = resolveEventLights(frame(), { lit: (x, y) => !(x === 400 && y === 400) });
  assert.equal(hiddenNozzle.some(l => l.id === 'trap:flame-a'), false);
  // Nothing at all when no source is visible.
  assert.deepEqual(resolveEventLights(frame(), { lit: () => false }), []);
});

test('switching lighting off removes every glow', () => {
  assert.deepEqual(resolveEventLights(frame(), { lighting: false }), []);
});

test('glows fade with the effect and follow interpolated shots, with no state between frames', () => {
  const at = alpha => resolveEventLights(frame(), { alpha });
  assert.ok(at(0.9).find(l => l.id === 'fx:1').strength < at(0).find(l => l.id === 'fx:1').strength);
  assert.equal(at(0.5).find(l => l.id === 'shot:4').x, 205);
  assert.deepEqual(at(0.5), at(0.5), 'same frame and alpha give the same glows');
});

test('the per-frame cap keeps the strongest glows in a stable order', () => {
  const crowded = { effects: Array.from({ length: 40 }, (_, i) => ({ id: 40 - i, kind: 'slash', x: i, y: 0, radius: 55, life: 1 + (i % 12) })) };
  const lights = resolveEventLights(crowded);
  assert.equal(lights.length, EVENT_LIGHT.max);
  for (let i = 1; i < lights.length; i++) assert.ok(lights[i - 1].strength >= lights[i].strength);
  const reversed = { effects: [...crowded.effects].reverse() };
  assert.deepEqual(resolveEventLights(reversed), lights, 'input order does not change the result');
  assert.equal(resolveEventLights(frame(), { inView: () => false }).length, 0, 'off-screen glows are skipped');
});

test('decorative glows never borrow a gameplay signal color or draw an outline', () => {
  for (const tint of Object.values(EVENT_LIGHT_TINTS)) assert.equal(Object.values(G).includes(tint), false);
  const calls = [];
  const g = new Proxy({}, { get: (_, name) => (...args) => { calls.push(name); return g; } });
  drawEventLights(g, resolveEventLights(frame()));
  assert.deepEqual([...new Set(calls)].sort(), ['clear', 'fillCircle', 'fillStyle']);
});

test('added light falls off from the centre, and props lift with the ground beneath them', () => {
  const lights = [{ id: 'fx:1', x: 0, y: 0, radius: 100, tint: 0xff8040, strength: 0.2 }];
  const red = d => eventLightAt(lights, d, 0)[0];
  assert.ok(red(0) > red(40) && red(40) > red(80) && red(80) > 0, 'brightest at the centre, fading outward');
  assert.equal(red(100), 0, 'nothing at or beyond the radius');
  assert.ok(red(0) - red(30) <= 255 * 0.2 / 4 + 1e-9, 'no step is larger than one disc');
  assert.equal(liftByEventLight(0x102030, [0, 0, 0]), 0x102030);
  assert.equal(liftByEventLight(0x102030, [16, 16, 16]), 0x203040);
  assert.equal(liftByEventLight(0xf0f0f0, [64, 0, 0]), 0xfff0f0, 'channels clamp');
});

test('event light stays presentation-only: no simulation, server or map code imports it', () => {
  for (const dir of ['shared', 'server', 'map']) for (const file of readdirSync(dir, { recursive: true })) {
    if (!/\.(m?[jt]s)$/.test(file) || file.includes('node_modules')) continue;
    assert.ok(!/event-light\.js/.test(readFileSync(path.join(dir, file), 'utf8')), `${dir}/${file} imports event-light.js`);
  }
});
