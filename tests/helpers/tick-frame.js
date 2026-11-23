import assert from 'node:assert/strict';

// Checks on the new tick's frames (docs/27.2 "Frames (3d.3)"), shared by tests/tick-adapter.test.js and its slow whole-match test.

/**
 * Hold a frame on the new path to the match's snapshot: one body per pose, owned by what the pose names, at the core's whole
 * pose, in body order. `words` is each roster place's actor word. Returns each body by its `kind:id` key, for identity
 * across ticks.
 */
export function checkFrame(frame, snap, tick, words) {
  assert.equal(frame.tick, snap.tick, `tick ${tick}`);
  assert.equal(frame.physics, undefined, 'a frame on the new path carries no old world state');
  assert.equal(frame.bodies.length, snap.poses.length, `tick ${tick}: one body per pose`);
  const bodies = new Map();
  snap.poses.forEach((pose, i) => {
    const body = frame.bodies[i], owner = body.owner;
    const id = owner.kind === 'actor' ? `actor:${words[owner.playerIdx]}`
      : owner.kind === 'item' ? `item:${owner.itemId}` : `prop:${owner.propId - 1}`;
    assert.equal(id, `${pose.body.kind}:${pose.body.id}`, `tick ${tick}: body ${i}`);
    assert.deepEqual([body.x, body.y, body.angle, body.vx, body.vy, body.omega, body.sleeping],
      [...pose.at, pose.angle, ...pose.velocity, pose.spin, pose.sleeping], `tick ${tick}: ${id}`);
    bodies.set(id, body);
  });
  return bodies;
}
