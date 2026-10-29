import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsWorld } from '../shared/physics/world.ts';

// Its own file, so this is the process's first initialization: two rooms created together on a slow
// runner used to instantiate Rapier twice, and the first room's world then failed to dispose.
test('worlds created before Rapier has initialized share one instance and dispose cleanly', async () => {
  const worlds = await Promise.all([createPhysicsWorld(), createPhysicsWorld(), createPhysicsWorld()]);
  for (const world of worlds) {
    world.queueAddBody({ id: 'wall', kind: 'static', shape: { kind: 'box', hx: 2, hy: 50 }, x: 100, y: 0 });
    world.commitMutations();
    world.step();
  }
  for (const world of worlds) assert.doesNotThrow(() => world.dispose());
});
