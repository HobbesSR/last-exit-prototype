import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, enqueuePhysicsAttachment, enqueuePhysicsImpulse, step, synchronizePhysics } from '../shared/simulation.ts';
import { canOccupy } from '../shared/movement.ts';
import { cos, hypot, sin } from '../shared/math.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { placeInCore } from '../shared/simulation/boundary.ts';
import { setDoor } from '../shared/simulation/doors.ts';
import { openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// The tick boundary's body work runs in the core (`rust/core/src/boundary.rs`, `placement.rs`, #1234, docs/27
// "Step 5b.3"): phase 1's station clearance and landing, the body sync and the pending admission. The fixture
// holds the tick unchanged; these hold what it reaches rarely or never: the placement search near walls, gates
// and props against the TypeScript search it replaced, the queries phase 1 used to stop for, and the sync's
// refusals partway, after which the records here and the world in the core must agree and the next sync finish.

/** The TypeScript placement search the core replaced (`placement` in game.ts before #1234), as the reference. */
function placementTs(s, r, p, admitted, origin) {
  const radius = s.content.actorPhysics.geometry[p.role].bodyRadius;
  const free = (x, y) => canOccupy(s.map, x, y, radius)
    && admitted.every(q => hypot(x - q.x, y - q.y) >= radius + s.content.actorPhysics.geometry[q.role].bodyRadius)
    && !r.world.overlapsProp(x, y, radius);
  if (free(origin.x, origin.y)) return { x: origin.x, y: origin.y };
  for (let ring = 1; ring <= 24; ring++) {
    for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, x = origin.x + cos(angle) * ring * 4, y = origin.y + sin(angle) * ring * 4;
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

/** A body's pose, which the engine keeps in f32, against the record's. */
const near = (body, x) => assert.ok(Math.abs(body.x - x) < 1e-3, `${body.x} is not ${x}`);

/** A field of crates with a wall, a crate prop and three gates, and two actors on it. */
async function field({ stations = [], obstacles = [], crates = true } = {}) {
  const { map } = openField(1920, { rows: 4, stations, ...crates ? { scatter: { density: 0.55, seed: 7 } } : {} });
  map.obstacles.push(...obstacles);
  map.gates = [{ id: 'd0', x: 700, y: 300, w: 26, h: 54, open: false, locked: false, kind: 'door' },
    { id: 'd1', x: 900, y: 420, w: 54, h: 26, open: true, locked: false, kind: 'door' },
    { id: 'd2', x: 1100, y: 200, w: 26, h: 54, open: false, locked: false, kind: 'door' }];
  map.physicsProps = [{ id: 'crate', profile: 'crate', x: 1300, y: 500, angle: Math.PI / 5 }];
  // Spots clear of the crates, found before the game exists, for the actors to start on.
  const spots = [];
  for (let x = 60; spots.length < 3 && x < 1900; x += 37) if (canOccupy(map, x, 700, 30)) spots.push({ x, y: 700 }), x += 120;
  const actors = [{ role: 'contestant', ...spots[0] }, { role: 'contestant', ...spots[1] }, { role: 'gladiator', ...spots[2] }];
  return stagePhysics(map, { actors: actors.map(a => ({ ...a, bot: false })) });
}

test('the core\'s placement search lands where the TypeScript\'s did, near crates, gates and a prop', async () => {
  const { s, players } = await field();
  try {
    const r = physicsRuntime(s), misses = [];
    let searched = 0, refused = 0, cases = 0;
    const origins = [];
    for (const o of s.map.obstacles) for (const [dx, dy] of [[-14, 0.5], [0.5, -14], [-3, -3], [0.5, 0.5]])
      origins.push({ x: o.x + (dx < 0 ? dx : o.w * dx), y: o.y + (dy < 0 ? dy : o.h * dy) });
    for (const g of s.gates) origins.push({ x: g.x, y: g.y }, { x: g.x + 20, y: g.y });
    origins.push({ x: 1300, y: 500 }, { x: 1320, y: 520 }, { x: -50, y: 300 }, { x: 960, y: -200 });
    for (let round = 0; round < 2; round++) {
      // Gates change between calls, through the core that keeps their state (#1214 stage 6a).
      if (round) s.gates.forEach((g, i) => setDoor(s, i, { open: !g.open }));
      for (const [k, origin] of origins.entries()) {
        const p = players[k % players.length], admitted = players.filter(q => q !== p);
        const want = placementTs(s, r, p, admitted, origin), got = placeInCore(s, r, p, admitted, origin);
        cases++;
        if (!want) refused++;
        else if (want.x !== origin.x || want.y !== origin.y) searched++;
        if (!(want === got || want && got && Object.is(want.x, got.x) && Object.is(want.y, got.y)))
          if (misses.push({ origin, want, got }) >= 5) break;
      }
    }
    assert.deepEqual(misses, []);
    // The cases reach the ring search and its refusal, not only free origins.
    assert.ok(searched > cases / 4 && refused > 0, `searched ${searched}, refused ${refused} of ${cases}`);
  } finally { disposePhysics(s); }
});

test('a respawn takes the westmost clear station', async () => {
  const stations = [{ id: 'st0', nodeId: 'n0', x: 1500, y: 150 }, { id: 'st1', nodeId: 'n1', x: 1800, y: 150 }];
  // The westmost station is walled in; it is ahead of the wall and far from every contestant, so only clearance refuses it.
  const { s, players: [, , g] } = await field({ stations, obstacles: [{ id: 'block', x: 1470, y: 120, w: 60, h: 60 }] });
  try {
    s.players.filter(p => p.role === 'contestant').forEach(p => { p.x = Math.min(p.x, 400); });
    synchronizePhysics(s);
    g.status = 'respawning'; g.respawnAt = s.tick + 1;
    const serial = s.serial;
    step(s);
    assert.deepEqual([g.status, g.x, g.y, s.serial > serial], ['active', 1800, 150, true]);
  } finally { disposePhysics(s); }
});

test('a sync refused partway keeps what it did, and the next one finishes', async () => {
  const { s, players: [a, b] } = await field();
  try {
    const r = physicsRuntime(s);
    b.status = 'eliminated'; synchronizePhysics(s);
    assert.equal(r.world.hasBody('actor:c1'), false);
    // c0 moves; c1 returns somewhere no body can go, with no body to fall back on: a contestant is refused.
    const ax = a.x + 30;
    a.x = ax; b.status = 'active'; b.x = -5000;
    r.discontinuities = [];
    assert.throws(() => synchronizePhysics(s), /no legal physics placement for c1/);
    // What came before the refusal is done, here and in the core alike.
    near(r.world.getTransform('actor:c0'), ax);
    assert.deepEqual([...r.actors].sort(), ['actor:c0', 'actor:g0']);
    assert.deepEqual(r.discontinuities.map(d => [d.id, d.kind]), [['actor:c0', 'placed']]);
    const bodies = r.world.snapshot({ includeStatic: false }).bodies.filter(body => body.spec.kind === 'actor');
    assert.deepEqual(bodies.map(body => body.spec.id), ['actor:c0', 'actor:g0']);
    // Resumed: the refused actor is placed once it can be.
    b.x = a.x + 200; b.y = a.y;
    synchronizePhysics(s);
    near(r.world.getTransform('actor:c1'), b.x);
    assert.equal(r.world.snapshot({ includeStatic: false }).bodies.find(body => body.spec.id === 'actor:c1').spec.shape.radius,
      s.content.actorPhysics.geometry.contestant.bodyRadius);
    // (A record the engine rounded to f32 is placed again at each sync, as it was before the core.)
    assert.ok(r.discontinuities.some(d => d.id === 'actor:c1' && d.kind === 'placed'));
  } finally { disposePhysics(s); }
});

test('a full marker list stops the sync after the teleport it marks, as the TypeScript threw there', async () => {
  const { s, players: [a, b] } = await field();
  try {
    const r = physicsRuntime(s);
    r.discontinuities = []; r.discontinuityCapacity = 1;
    a.x += 20; b.x += 20;
    assert.throws(() => synchronizePhysics(s), /physics discontinuity capacity/);
    // c0 was marked; c1 was moved, then refused its marker.
    assert.deepEqual(r.discontinuities.map(d => d.id), ['actor:c0']);
    near(r.world.getTransform('actor:c0'), a.x); near(r.world.getTransform('actor:c1'), b.x);
    // The next sync finishes. c1's body stands where its record says, so it is not placed again, but the
    // markers' list now has room for whatever is.
    r.discontinuityCapacity = 256;
    synchronizePhysics(s);
    near(r.world.getTransform('actor:c1'), b.x);
    step(s);
  } finally { disposePhysics(s); }
});
