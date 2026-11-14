import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { damage } from '../shared/simulation/combat.ts';
import { enqueueExplosionImpulses } from '../shared/simulation/explosion-physics.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { createGameRecord } from '../shared/simulation/state.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { stepTraps } from '../shared/traps.ts';
import { openField, openArea } from './helpers/arena.js';

function parts() {
  const map = { seed: 445, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 150, y: 400 }], hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

async function physicsGame() {
  const fixture = parts();
  return createGame(445, fixture.map, fixture.content);
}

function mineAt(x, y) {
  return { id: 'mine', kind: 'mine', x, y, spent: false };
}

test('mine damage and physical impulse are independent, and impulse is queued for next tick', async () => {
  const s = await physicsGame();
  try {
    const p = s.players.find(player => player.role === 'contestant');
    const runtime = physicsRuntime(s);
    p.x = 250; p.y = 400; p.movedThisTick = 1; p.shield = 60;
    runtime.world.setTransform(`actor:${p.id}`, { x: p.x, y: p.y, angle: 0 });
    s.map.traps = [mineAt(230, 400)];
    stepTraps(s, damage, () => {});
    assert.equal(p.shield, 15, 'the mine keeps its existing damage outcome');
    assert.equal(p.hp, 100);
    assert.deepEqual(runtime.pendingImpulses.find(effect => effect.id === `actor:${p.id}`)?.value, { x: 250, y: 0 });
    assert.deepEqual(runtime.world.getTransform(`actor:${p.id}`).vx, 0, 'the mine does not mutate the current solve');
  } finally { disposePhysics(s); }
});

test('static map cover blocks mine damage and its queued impulse', async () => {
  const fixture = parts();
  fixture.map.obstacles.push({ id: 'blast-cover', x: 240, y: 350, w: 4, h: 100 });
  const s = await createGame(445, fixture.map, fixture.content);
  try {
    const p = s.players.find(player => player.role === 'contestant');
    const runtime = physicsRuntime(s);
    p.x = 250; p.y = 400; p.movedThisTick = 1; p.shield = 60;
    runtime.world.setTransform(`actor:${p.id}`, { x: p.x, y: p.y, angle: 0 });
    s.map.traps = [mineAt(220, 400)];
    stepTraps(s, damage, () => {});
    assert.equal(p.shield, 60);
    assert.equal(runtime.pendingImpulses.some(effect => effect.id === `actor:${p.id}`), false);
  } finally { disposePhysics(s); }
});

test('explosion impulse uses linear falloff, deterministic zero-distance direction and stable body ID order', async () => {
  const s = await physicsGame();
  try {
    const runtime = physicsRuntime(s);
    const contestant = s.players.find(player => player.role === 'contestant');
    const gladiator = s.players.find(player => player.role === 'gladiator');
    contestant.x = 300; contestant.y = 400;
    gladiator.x = 360; gladiator.y = 400;
    runtime.world.setTransform(`actor:${contestant.id}`, { x: 300, y: 400, angle: 0 });
    runtime.world.setTransform(`actor:${gladiator.id}`, { x: 360, y: 400, angle: 0 });
    runtime.world.queueAddBody({ id: 'prop:test', kind: 'prop', shape: { kind: 'circle', radius: 8 }, x: 330, y: 400, mass: 1 });
    runtime.world.commitMutations();
    enqueueExplosionImpulses(s, { x: 300, y: 400 }, 120);
    assert.deepEqual(runtime.pendingImpulses.map(effect => effect.id), ['actor:c0', 'actor:g0', 'prop:test']);
    assert.deepEqual(runtime.pendingImpulses.map(effect => effect.value), [
      { x: 300, y: 0 }, { x: 150, y: 0 }, { x: 225, y: 0 },
    ]);
  } finally { disposePhysics(s); }
});

test('a mine without a stepped physics world only deals damage', () => {
  const s = createGameRecord(4217, openField(1200).map, defaultContent());
  const p = s.players.find(player => player.role === 'contestant');
  s.map.items = [];
  p.x = 600; p.y = 576; p.movedThisTick = 1; p.shield = 60;
  s.map.traps = [mineAt(580, 576)];
  stepTraps(s, damage, () => {});
  assert.equal(p.shield, 15);
  assert.equal(p.hp, 100);
});
