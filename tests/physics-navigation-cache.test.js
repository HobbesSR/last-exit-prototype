import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { observedBlockers } from '../shared/simulation/dynamic-navigation.ts';

test('bots share one prop query during collection, while same-tick external moves are observed freshly', async () => {
  const content = structuredClone(contentById('content-physics-8'));
  content.discovery = false;
  content.roster = { contestants: ['A', 'B'], gladiators: [] };
  const map = { seed: 448, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [],
    sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    physicsProps: [{ id: 'crate', profile: 'crate', x: 300, y: 450 }],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns: [{ x: 150, y: 400 }, { x: 150, y: 500 }] };
  const s = await createPhysicsGame(448, map, content);
  try {
    const world = physicsRuntime(s).world, query = world.solidPropStates.bind(world);
    let calls = 0;
    world.solidPropStates = () => { calls++; return query(); };
    step(s);
    assert.equal(calls, 1, 'both bots consumed the same pre-movement prop list');
    const p = s.players[0], tick = s.tick;
    assert.ok(observedBlockers(s, p).some(shape => shape.kind === 'polygon'), 'nearby prop remains observed after the collection');
    world.setTransform('prop:crate', { x: 650, y: 650, angle: 0 });
    assert.equal(s.tick, tick);
    assert.equal(observedBlockers(s, p).some(shape => shape.kind === 'polygon'), false, 'no tick-keyed stale prop pose survives');
    assert.equal(calls, 3, 'outside collection each read is fresh');
    step(s);
    assert.equal(calls, 4, 'the next collection obtains a new shared query');
  } finally { disposePhysics(s); }
});
