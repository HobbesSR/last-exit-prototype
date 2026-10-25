import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsGame, disposePhysics, enqueuePhysicsImpulse, snapshot, step, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { automaticPickups, dropInventorySlot } from '../shared/simulation/loot.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { createPhysicsMatch } from '../server/match.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { enqueueExplosionImpulses } from '../shared/simulation/explosion-physics.ts';

const parts = () => ({ map: { seed: 445, width: 800, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 8]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], traps: [], routes: [], nodes: [], streets: [],
  items: [{ id: 'sleeping', kind: 'cell', charge: 100, x: 300, y: 200 }],
  physicsProps: [{ id: 'hidden', profile: 'crate', x: 650, y: 200 }],
  entry: { x: 50, y: 200 }, exit: { x: 750, y: 200 }, spawns: [{ x: 120, y: 200 }] },
  content: { ...structuredClone(contentById('content-physics-5')), roster: { contestants: ['A'], gladiators: [] }, discovery: false } });

test('loot never blocks actor placement, pickup emits a typed removal, and replacement rejects stale impulses', async () => {
  const { map, content } = parts(), s = await createPhysicsGame(445, map, content);
  try {
    const p = s.players[0], r = physicsRuntime(s); p.bot = false;
    assert.deepEqual(teleport(s, p.id, 300, 200), { x: 300, y: 200 });
    synchronizePhysics(s);
    enqueuePhysicsImpulse(s, 'item:sleeping', { x: 300, y: 0 });
    const generation = r.world.getGeneration('item:sleeping');
    automaticPickups(s, p, {});
    assert.equal(r.world.hasBody('item:sleeping'), false);
    assert.ok(snapshot(s).physics.discontinuities.some(d => d.id === 'item:sleeping' && d.kind === 'removed' && d.generation === generation));
    assert.equal(dropInventorySlot(s, p, 0), true);
    assert.notEqual(r.world.getGeneration('item:sleeping'), generation);
    // Remove the authored drop velocity so any stale explosion impulse is observable.
    const pose = r.world.getTransform('item:sleeping');
    r.world.setTransform('item:sleeping', pose);
    step(s);
    assert.equal(r.world.getTransform('item:sleeping').vx, 0);
  } finally { disposePhysics(s); }
});

test('many same-boundary explosions keep one bounded impulse per body/generation', async () => {
  const { map, content } = parts(), s = await createPhysicsGame(445, map, content);
  try {
    const r = physicsRuntime(s);
    for (let i = 0; i < 200; i++) enqueueExplosionImpulses(s, { x: 200, y: 200 }, 500);
    assert.equal(r.pendingImpulses.length, 3);
    for (const impulse of r.pendingImpulses) assert.ok(Math.hypot(impulse.value.x, impulse.value.y) <= (impulse.id.startsWith('actor:') ? 600 : 300));
  } finally { disposePhysics(s); }
});

test('client maps omit crate authoring while recordings retain engine-free physical frames', async () => {
  const { map, content } = parts();
  const match = await createPhysicsMatch(445, undefined, map, content);
  try {
    assert.equal(Object.hasOwn(match.liveMap(), 'physicsProps'), false);
    assert.equal(Object.hasOwn(match.spectatorMap(match.snapshot()), 'physicsProps'), false);
    assert.equal(match.map().physicsProps[0].id, 'hidden');
    const a = match.snapshot(), b = match.advance();
    const timeline = createReplayTimeline({ schema: 12, minSchema: 10, map: match.map(), frames: [{ state: a }, { state: b }] });
    // State-only timeline preserves recorded body and item identity across backward seeks.
    assert.deepEqual(timeline.at(b.tick).state.bodies, b.bodies);
    assert.deepEqual(timeline.at(a.tick).state.items, a.items);
  } finally { match.dispose(); }
});

test('staged swaps reserve full batches ahead of older mandatory overflow', async () => {
  const { interact } = await import('../shared/simulation/interactions.ts');
  for (const copies of [1, 2]) {
    const { map, content } = parts(), s = await createPhysicsGame(445, map, content);
    try {
      const p = s.players[0], r = physicsRuntime(s);
      p.bot = false; p.x = 300; p.y = 200;
      for (let i = 0; i < 6; i++) p.inventory[i] = { kind: 'cell', charge: i, instanceId: `out-${i}`, lineageId: `out-${i}` };
      if (copies === 2) p.inventory[0] = { kind: 'med', count: 2, instanceId: 'out-0', lineageId: 'out-0' };
      let n = 0;
      // The two-unit drop needs its incoming slot plus one currently free slot.
      while (r.world.canAddBodies(copies)) r.world.queueAddBody({ id: `filler-${n++}`, kind: 'prop',
        x: 700, y: 50, shape: { kind: 'circle', radius: 2 } });
      r.world.commitMutations();
      s.map.items.push({ id: 'aaa-overflow', kind: 'cell', charge: 100, x: 500, y: 200 });
      interact(s, p);
      assert.equal(p.inventory[0].instanceId, 'sleeping');
      const outgoing = s.map.items.filter(i => i.lineageId === 'out-0');
      assert.equal(outgoing.length, copies);
      assert.ok(outgoing.every(i => r.world.hasBody(`item:${i.id}`)));
      assert.equal(r.world.hasBody('item:aaa-overflow'), false);
    } finally { disposePhysics(s); }
  }
});

test('invalid tiny physical profiles are refused before item/body admission', async () => {
  for (const change of [p => p.loot.radius = 0.01, p => p.loot.mass = 1e-9, p => p.prop.hx = 0.01]) {
    const { map, content } = parts(); change(content.worldPhysics);
    await assert.rejects(createPhysicsGame(445, map, content), /world physics profile/);
  }
});

test('forty physical pickup/drop cycles conserve the objective without body or joint growth', async () => {
  const { map, content } = parts(), s = await createPhysicsGame(445, map, content);
  try {
    const p = s.players[0], r = physicsRuntime(s); p.bot = false;
    p.x = 300; p.y = 200; automaticPickups(s, p, {});
    const baseline = r.world.counts().dynamic;
    let generation = 0;
    for (let cycle = 0; cycle < 40; cycle++) {
      p.x = 120; p.y = 200; synchronizePhysics(s);
      assert.equal(dropInventorySlot(s, p, 0), true);
      const dropped = s.map.items[0];
      assert.equal(dropped.id, 'sleeping'); assert.equal(dropped.charge, 100);
      assert.equal(r.world.counts().dynamic, baseline + 1);
      const nextGeneration = r.world.getGeneration('item:sleeping');
      assert.ok(nextGeneration > generation); generation = nextGeneration;
      p.x = dropped.x; p.y = dropped.y; dropped.pickupAfter = 0;
      automaticPickups(s, p, {});
      assert.equal(p.inventory[0].instanceId, 'sleeping'); assert.equal(p.inventory[0].charge, 100);
      assert.equal(s.map.items.length, 0);
      assert.equal(r.world.counts().dynamic, baseline);
      assert.equal(r.world.counts().constraints, 0);
      assert.equal(r.pendingImpulses.length, 0); assert.equal(r.pendingAttachments.length, 0);
    }
  } finally { disposePhysics(s); }
});
