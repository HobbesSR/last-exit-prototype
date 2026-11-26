import assert from 'node:assert/strict';
import { heardOf } from '../../shared/simulation/tick-projection.ts';
import { projectView, viewSourceOf } from '../../shared/simulation/visibility.ts';

// Checks on the new tick's frames (docs/27.2 "Frames (3d.3)") and the knowledge written beside them, shared by
// tests/tick-adapter.test.js and its slow whole-match test.

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

/**
 * Hold the frame store's records, folded tick by tick from the change lists, to the whole snapshot mapped the same way
 * (`TickFrames.recordsOf`): every player field the core decides, the ground, projectiles, gates, traps, slots and wall.
 * The ground is compared in ID order; an actor without a body has no place in a snapshot, so its place is left out.
 */
export function checkRecords(frames, snap, tick) {
  const comparable = records => {
    const posed = new Set(snap.poses.filter(p => p.body.kind === 'actor').map(p => p.body.id));
    const words = frames.ctx.ids.actorAtSlot;
    return { ...records, items: [...records.items].sort((a, b) => a.id - b.id),
      players: records.players.map((p, slot) => { if (posed.has(words[slot])) return p; const { x, y, ...rest } = p; return rest; }) };
  };
  assert.deepEqual(comparable(frames.records()), comparable(frames.recordsOf(snap)), `tick ${tick}: records`);
}

/**
 * Hold the knowledge the core sends with its decisions (`TickProjection`: cells learned since those held, the live cues) to
 * the core's whole memory and cues as of its last completed tick; and hold that a started game's players keep neither
 * (#1343, #1357). `remembers` limits which contestants' memory is decoded: decoding every memory every tick dominates a
 * whole match's check.
 */
export function checkKnowledge(s, match, projection, tick, remembers = () => true) {
  s.players.forEach((p, slot) => {
    assert.equal(p.discovery ?? p.heard, undefined, `tick ${tick}: ${p.id}'s knowledge is the core's, not the game's`);
    const live = match.heard(p.id).map(heardOf).filter(cue => cue.until > tick);
    assert.deepEqual([...projection.heard(slot, tick)], live, `tick ${tick}: ${p.id} hears`);
    if (!remembers(p)) return;
    const memory = p.role === 'contestant' && s.content.discovery === true ? match.memory(p.id) : null;
    const cells = projection.discovered(slot);
    assert.deepEqual(cells && [...cells].sort((a, b) => a - b), memory && [...memory.discovered].sort((a, b) => a - b),
      `tick ${tick}: ${p.id} has discovered`);
  });
}

/**
 * The A/B check of the core's projection (docs/27.2 "The core's projection", #1357): every player's view of `frame`, from the
 * core's decision in one call, equals the TypeScript rules' view of it, field for field. Each view is required to come from
 * the core: a missing decision fails rather than letting the rules stand in. Returns how many views were compared.
 */
export function checkProjection(s, projection, frame, tick, ids = s.players.map(p => p.id)) {
  projection.decide(ids);
  for (const id of ids) {
    const core = projection.project(frame, id);
    assert.ok(core, `tick ${tick}: no core decision for ${id}`);
    assert.deepEqual(core, projectView(viewSourceOf(s), frame, id), `tick ${tick}: ${id}'s view`);
  }
  return ids.length;
}
