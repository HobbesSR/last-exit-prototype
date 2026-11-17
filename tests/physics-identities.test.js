import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime, physicsState } from '../shared/simulation/physics-runtime.ts';
import { capturePhysicsPresentation, legacyPhysicsPresentation, projectPhysicsPresentation } from '../shared/simulation/physics-presentation.ts';
import { POTENTIAL } from '../shared/simulation/visibility.ts';
import { arena } from './helpers/arena.js';

const fixture = (cols = 8) => ({
  content: { ...structuredClone(contentById('content-7')), roster: { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] }, discovery: false },
  map: arena({ seed: 446, cols, rows: 8, cellSize: 100,
    items: [{ id: 'loot', kind: 'cell', charge: 100, x: 300, y: 400 }],
    physicsProps: [{ id: 'crate', profile: 'crate', x: 350, y: 400 }],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 250, y: 400 }], hunterSpawns: [{ x: 150, y: 400 }] }).map,
});
const capture = s => capturePhysicsPresentation(s);
const byLabel = (p, label) => p.bodies.find(b => p.legacy.bodies.get(b.id) === label);

test('body lifetime survives transforms and damping but committed re-admission mints a new id', async () => {
  const { map, content } = fixture(), s = await createGame(446, map, content);
  try {
    const r = physicsRuntime(s), w = r.world, initial = capture(s), serial = s.serial;
    const actor = byLabel(initial, 'actor:c0'), prop = byLabel(initial, 'prop:crate');
    assert.ok(actor && prop);
    const lifetime = w.bodyLifetime('actor:c0'), generation = w.getGeneration('actor:c0');
    w.setTransform('actor:c0', { x: 260, y: 400, angle: 0 });
    w.setDamping('actor:c0', 2, 2);
    assert.notEqual(w.getGeneration('actor:c0'), generation);
    assert.equal(w.bodyLifetime('actor:c0'), lifetime);
    assert.equal(byLabel(capture(s), 'actor:c0').id, actor.id);
    const link = { id: 'link', a: 'actor:c0', b: 'prop:crate', maxDistance: 200 };
    w.queueAddConstraint(link); w.commitMutations();
    const firstLink = capture(s).tethers[0];
    w.queueRemoveConstraint('link'); w.commitMutations();
    w.queueAddConstraint(link); w.commitMutations();
    assert.ok(capture(s).tethers[0].id > firstLink.id, 'ordinary constraint re-admission has a fresh identity');
    for (const label of ['actor:c0', 'item:loot', 'prop:crate']) {
      const spec = physicsState(s).world.bodies.find(b => b.spec.id === label).spec;
      const before = byLabel(capture(s), label);
      w.queueRemoveBody(label); w.commitMutations();
      w.queueAddBody(spec); w.commitMutations();
      const after = byLabel(capture(s), label);
      assert.ok(after.id > before.id, `${label} is a new body even when the gap was not captured`);
      if (label === 'prop:crate') assert.deepEqual(after.owner, before.owner);
    }
    const spec = physicsState(s).world.bodies.find(b => b.spec.id === 'prop:crate').spec;
    const before = byLabel(capture(s), 'prop:crate');
    w.queueRemoveBody(spec.id); w.queueAddBody(spec); w.commitMutations();
    assert.ok(byLabel(capture(s), spec.id).id > before.id, 'same-commit replacement also has a fresh lifetime');
    assert.equal(s.serial, serial);
  } finally { disposePhysics(s); }
});

test('typed owners and captured labels survive metadata changes and viewer visibility', async () => {
  const { map, content } = fixture(Math.ceil((POTENTIAL + 1000) / 100)), s = await createGame(446, map, content);
  try {
    const p = capture(s), actor = byLabel(p, 'actor:c0'), item = byLabel(p, 'item:loot'), prop = byLabel(p, 'prop:crate');
    assert.deepEqual(actor.owner, { kind: 'actor', playerIdx: 0 });
    assert.equal(item.owner.kind, 'item'); assert.equal(prop.owner.kind, 'prop');
    assert.ok(Number.isInteger(item.owner.itemId) && Number.isInteger(prop.owner.propId));
    const legacy = legacyPhysicsPresentation(p);
    const frame = snapshot(s);
    const visible = playerView(s, frame, 'c0');
    assert.ok(visible.bodies.some(b => b.id === 'prop:crate'));
    const numericByLabel = new Map([...p.legacy.bodies].map(([id, label]) => [label, id]));
    for (const viewer of ['c0', 'g0', null]) {
      const view = playerView(s, frame, viewer);
      assert.deepEqual(view.bodies.map(b => numericByLabel.get(b.id)), p.bodies.map(b => b.id),
        'all authorized viewers share the match capture identities');
    }
    const world = physicsRuntime(s).world;
    const propId = prop.id;
    const viewer = s.players.find(p => p.id === 'c0');
    world.setTransform('prop:crate', { x: viewer.x + POTENTIAL + 100, y: viewer.y, angle: 0 });
    const outside = snapshot(s);
    assert.equal(playerView(s, outside, 'c0').bodies.some(b => b.id === 'prop:crate'), false,
      'a prop outside potential range is hidden');
    world.setTransform('prop:crate', { x: 350, y: 400, angle: 0 });
    const returned = snapshot(s);
    const returnedView = playerView(s, returned, 'c0');
    const returnedProp = returnedView.bodies.find(b => b.id === 'prop:crate');
    assert.ok(returnedProp, 'the same prop becomes visible again on reentry');
    assert.equal(numericByLabel.get(returnedProp.id), propId,
      'the reappearing legacy label maps to the same captured numeric BodyId');
    const again = capture(s);
    assert.equal(byLabel(again, 'prop:crate').id, prop.id);
    assert.equal(byLabel(again, 'actor:c0').id, actor.id);
    s.players[0].id = 'renamed';
    assert.deepEqual(legacyPhysicsPresentation(p), legacy, 'delayed adaptation uses captured labels');
    assert.equal(legacy.bodies.find(b => b.id === 'actor:c0').actorId, 'c0');
    assert.equal(legacy.bodies.find(b => b.id === 'item:loot').itemId, 'loot');
  } finally { disposePhysics(s); }
});

test('hook identity spans flight, pending, and replaced ropes; projection requires authorized endpoints', async () => {
  const { map, content } = fixture(), s = await createGame(446, map, content);
  try {
    s.players.forEach(p => { p.bot = false; });
    setInput(s, 'g0', { seq: 1, skill: true, aim: 0 }); step(s);
    const r = physicsRuntime(s), flight = capture(s), id = flight.hookFlights[0].id;
    assert.equal(r.hooks[0].phase, 'flying');
    assert.equal(flight.hookFlights[0].a, byLabel(flight, 'actor:g0').id);
    assert.equal(Object.hasOwn(physicsState(s).hooks[0], 'tetherId'), false);
    const flightFrame = snapshot(s), caster = s.players.find(p => p.id === 'g0');
    assert.equal(projectPhysicsPresentation(flightFrame, caster, new Set(['c0']), flightFrame.items, () => true).hookFlights.length, 0);
    assert.equal(projectPhysicsPresentation(flightFrame, caster, new Set(['g0']), flightFrame.items, () => false).hookFlights.length, 0);
    assert.equal(projectPhysicsPresentation(flightFrame, caster, new Set(['g0']), flightFrame.items, () => true).hookFlights.length, 1);
    step(s); assert.equal(r.hooks[0].phase, 'pending'); assert.equal(r.hooks[0].tetherId, id);
    step(s); assert.equal(r.hooks[0].phase, 'pulling');
    let pulling = capture(s), tether = pulling.tethers[0];
    assert.equal(tether.id, id);
    assert.deepEqual(new Set([tether.a, tether.b]), new Set([byLabel(pulling, 'actor:c0').id, byLabel(pulling, 'actor:g0').id]));
    const frame = snapshot(s);
    for (const authorized of [new Set(['c0']), new Set(['g0'])])
      assert.equal(projectPhysicsPresentation(frame, caster, authorized, frame.items, () => true).tethers.length, 0);
    assert.equal(projectPhysicsPresentation(frame, caster, new Set(['c0', 'g0']), frame.items, () => true).tethers.length, 1);
    step(s); pulling = capture(s); assert.equal(pulling.tethers[0].id, id);
    setInput(s, 'g0', { seq: 5, skill: true }); step(s);
    caster.cooldown = 0;
    setInput(s, 'g0', { seq: 6, skill: true, aim: 0 }); step(s);
    assert.ok(r.hooks[0].tetherId > id);
    assert.equal(r.hooks[0].id, 'hook:g0');
  } finally { disposePhysics(s); }
});
