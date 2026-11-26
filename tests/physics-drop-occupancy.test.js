import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { scatterPoint } from '../shared/simulation/loot.ts';
import { openArea } from './helpers/arena.js';

const map = (props = []) => ({ seed: 448, width: 800, height: 800,
  playableArea: openArea(800, 800, 100),
  buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], physicsProps: props,
  entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns: [{ x: 120, y: 400 }] });
const content = () => ({ ...structuredClone(contentById('content-6')), dynamicNavigation: true,
  roster: { contestants: ['A'], gladiators: [] }, discovery: false });

// The drops themselves (crowded and unplaceable optional drops, a swap's outgoing drop, the mandatory fallback) are the core's:
// `rust/core/src/tick/tests/item_tests.rs` and `admission_tests.rs`. What stays is the scatter search over the live engine.
test('scatter avoids active actor footprints and rotated prop colliders', async () => {
  const s = await createGame(448, map([{ id: 'crate', profile: 'crate', x: 350, y: 400, angle: Math.PI / 4 }]), content());
  try {
    const r = physicsRuntime(s), origin = { x: 300, y: 400 };
    const first = { x: 336, y: 400 };
    assert.equal(r.world.overlapsProp(first.x, first.y, s.content.worldPhysics.loot.radius), true);
    const byCrate = scatterPoint(s, origin, 0, []);
    assert.ok(byCrate);
    assert.notDeepEqual(byCrate, first);
    assert.equal(r.world.overlapsProp(byCrate.x, byCrate.y, s.content.worldPhysics.loot.radius), false);

    // Move the actor to the first otherwise legal point in a clear region.
    const actor = s.players[0], actorOrigin = { x: 500, y: 500 };
    actor.x = actorOrigin.x + 36; actor.y = actorOrigin.y;
    synchronizePhysics(s);
    const byActor = scatterPoint(s, actorOrigin, 0, []);
    assert.ok(byActor);
    assert.notDeepEqual(byActor, { x: actor.x, y: actor.y });
    assert.ok(Math.hypot(byActor.x - actor.x, byActor.y - actor.y)
      >= s.content.worldPhysics.loot.radius + s.content.actorPhysics.geometry[actor.role].bodyRadius);
  } finally { disposePhysics(s); }
});
