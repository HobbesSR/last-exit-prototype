import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsGame, disposePhysics, playerView, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { capturePhysicsPresentation } from '../shared/simulation/physics-presentation.ts';
import { POTENTIAL } from '../shared/simulation/visibility.ts';

const map = () => ({ seed: 446, width: 800, height: 800,
  playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
  spawns: [{ x: 350, y: 400 }], hunterSpawns: [{ x: 150, y: 400 }] });

test('flight capture and projection disclose only an authorized caster and tip', async () => {
  const content = structuredClone(contentById('content-physics-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] };
  const s = await createPhysicsGame(446, map(), content);
  try {
    const r = physicsRuntime(s);
    const old = snapshot(s);
    assert.equal(Object.hasOwn(old, 'hookFlights'), true);
    assert.deepEqual(old.hookFlights, []);
    const caster = s.players.find(p => p.id === 'g0');
    const viewer = s.players.find(p => p.id === 'c0');
    const id = 'hook:g0';
    r.hooks.push({ id, caster: caster.id, x: 240, y: 400, dx: 1, dy: 0,
      travelled: 90, startedTick: s.tick, phase: 'flying', generationA: r.world.getGeneration('actor:g0'),
      target: 'c0', hitTick: 7, privateMarker: 'secret' });
    const frame = snapshot(s);
    assert.deepEqual(frame.hookFlights, [{ id, a: 'actor:g0', x: 240, y: 400 }]);
    assert.deepEqual(playerView(s, frame, viewer.id).hookFlights, frame.hookFlights);
    assert.equal(JSON.stringify(playerView(s, frame, viewer.id)).includes('secret'), false);
    const farTip = structuredClone(frame);
    farTip.hookFlights[0].x = viewer.x + POTENTIAL + 1;
    assert.deepEqual(playerView(s, farTip, viewer.id).hookFlights, []);
    const hiddenCaster = structuredClone(frame);
    hiddenCaster.players.find(p => p.id === caster.id).x = viewer.x + POTENTIAL + 1;
    assert.deepEqual(playerView(s, hiddenCaster, viewer.id).hookFlights, []);
    const poisoned = structuredClone(frame);
    poisoned.hookFlights[0].target = 'private-target';
    assert.deepEqual(playerView(s, poisoned, viewer.id).hookFlights, frame.hookFlights);
    assert.equal(JSON.stringify(playerView(s, poisoned, viewer.id)).includes('private-target'), false);
    r.hooks[0].phase = 'pending';
    assert.deepEqual(snapshot(s).hookFlights, []);
    r.hooks[0].phase = 'pulling';
    assert.deepEqual(snapshot(s).hookFlights, []);
    const noHooks = structuredClone(frame.physics);
    delete noHooks.hooks;
    assert.equal(Object.hasOwn(capturePhysicsPresentation(noHooks, frame.players, () => undefined), 'hookFlights'), false,
      'older physics captures preserve optional-field absence');
  } finally { disposePhysics(s); }
});

test('only the caster learns its hook is active, through flight, pending and pull', async () => {
  const content = structuredClone(contentById('content-physics-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] };
  const s = await createPhysicsGame(446, map(), content);
  try {
    const r = physicsRuntime(s);
    assert.equal(playerView(s, snapshot(s), 'g0').hookActive, false);
    r.hooks.push({ id: 'hook:g0', caster: 'g0', x: 240, y: 400, dx: 1, dy: 0, travelled: 90,
      startedTick: s.tick, phase: 'flying', generationA: r.world.getGeneration('actor:g0') });
    for (const phase of ['flying', 'pending', 'pulling']) {
      r.hooks[0].phase = phase;
      const frame = snapshot(s);
      assert.equal(playerView(s, frame, 'g0').hookActive, true, phase);
      assert.equal(playerView(s, frame, 'c0').hookActive, false, phase);
    }
  } finally { disposePhysics(s); }
  const older = structuredClone(contentById('content-physics-5'));
  older.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'warden' }] };
  const p5 = await createPhysicsGame(446, map(), older);
  try { assert.equal(Object.hasOwn(playerView(p5, snapshot(p5), 'g0'), 'hookActive'), false); }
  finally { disposePhysics(p5); }
});
