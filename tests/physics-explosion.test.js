import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { damage } from '../shared/simulation/combat.ts';
import { enqueueExplosionImpulses } from '../shared/simulation/explosion-physics.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { createGame } from '../shared/simulation/state.ts';
import { stepTraps } from '../shared/traps.ts';

function parts(contentId = 'content-physics-5', obstacles = []) {
  const map = { seed: 445, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 150, y: 400 }], hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById(contentId));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

async function physicsGame() {
  const fixture = parts();
  return createPhysicsGame(445, fixture.map, fixture.content);
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
  const s = await createPhysicsGame(445, fixture.map, fixture.content);
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

test('legacy mine remains damage-only', () => {
  const s = createGame();
  const p = s.players.find(player => player.role === 'contestant');
  s.map.obstacles = []; s.map.gates = []; s.map.items = [];
  p.x = 10000; p.y = 6000; p.movedThisTick = 1; p.shield = 60;
  s.map.traps = [mineAt(9980, 6000)];
  stepTraps(s, damage, () => {});
  assert.equal(p.shield, 15);
  assert.equal(p.hp, 100);
});
