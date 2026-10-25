import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, HZ, setInput, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { actorRadius } from '../shared/simulation/actor-physics.ts';
import { dynamicWaypoint } from '../shared/simulation/dynamic-navigation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';

const walls = [
  { id: 'top', x: 100, y: 100, w: 600, h: 270 },
  { id: 'bottom', x: 100, y: 430, w: 600, h: 270 },
];

async function game({ spawns = [{ x: 150, y: 400 }], props = [] } = {}) {
  const map = { seed: 448, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: walls, gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], physicsProps: props,
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 }, spawns,
    hunterSpawns: [{ x: 300, y: 400 }] };
  const content = structuredClone(contentById('content-physics-8'));
  content.roster = { contestants: spawns.map((_, i) => `C${i}`), gladiators: [] };
  content.discovery = false;
  const s = await createPhysicsGame(448, map, content);
  for (const p of s.players) p.bot = false;
  return s;
}

function move(s, p, target) {
  const at = dynamicWaypoint(s, p, target);
  const dx = at.x - p.x, dy = at.y - p.y;
  const length = Math.max(9, Math.hypot(dx, dy));
  assert.ok(setInput(s, p.id, { seq: s.tick + 1, x: dx / length, y: dy / length }));
  return at;
}

function checkedStep(s, p, before) {
  step(s);
  const pose = physicsRuntime(s).world.getTransform(`actor:${p.id}`);
  assert.ok(pose && Math.hypot(pose.x - p.x, pose.y - p.y) < 0.01,
    `gameplay and body poses agree at tick ${s.tick}`);
  assert.ok(Math.hypot(p.x - before.x, p.y - before.y) <= s.content.actorPhysics.maxSpeed / HZ + 0.02,
    `actor jumped at tick ${s.tick}: ${JSON.stringify({ before, after: { x: p.x, y: p.y } })}`);
  assert.ok(p.y >= 370 + actorRadius(s, p) - 0.6 && p.y <= 430 - actorRadius(s, p) + 0.6,
    `actor crossed corridor wall at tick ${s.tick}: y=${p.y}`);
}

test('P8 follower closes the gap in a 60-unit corridor and resumes when its leader moves', async () => {
  const s = await game({ spawns: [{ x: 150, y: 400 }, { x: 350, y: 400 }] });
  try {
    const [follower, leader] = s.players;
    let closest = Infinity;
    for (let i = 0; i < 400; i++) {
      const before = { x: follower.x, y: follower.y };
      move(s, follower, { x: 750, y: 400 });
      if (leader.x < 700) assert.ok(setInput(s, leader.id, { seq: s.tick + 1, x: 1, y: 0 }));
      else assert.ok(setInput(s, leader.id, { seq: s.tick + 1, x: 0, y: 0 }));
      checkedStep(s, follower, before);
      if (leader.x >= 695) closest = Math.min(closest, leader.x - follower.x);
    }
    const contact = actorRadius(s, follower) + actorRadius(s, leader) + 2;
    assert.ok(closest <= contact + 5, `follower stayed too far behind: closest ${closest}, contact ${contact}`);
    assert.ok(follower.x < leader.x - 15, 'follower did not tunnel through leader');
    const beforeResume = follower.x;
    for (let i = 0; i < 40; i++) {
      const before = { x: follower.x, y: follower.y };
      move(s, follower, { x: 750, y: 400 });
      assert.ok(setInput(s, leader.id, { seq: s.tick + 1, x: 1, y: 0 }));
      checkedStep(s, follower, before);
    }
    assert.ok(follower.x > beforeResume + 10, `follower did not resume: ${beforeResume} -> ${follower.x}`);
  } finally { disposePhysics(s); }
});

test('P8 motor pushes a corridor-filling crate forward without tunneling or teleporting', async () => {
  const s = await game({ props: [{ id: 'crate', profile: 'crate', x: 350, y: 400, angle: Math.PI / 2 }] });
  try {
    const p = s.players[0], world = physicsRuntime(s).world;
    const startCrate = world.getTransform('prop:crate').x;
    for (let i = 0; i < 400 && p.x < 650; i++) {
      const before = { x: p.x, y: p.y };
      move(s, p, { x: 750, y: 400 });
      checkedStep(s, p, before);
      const crate = world.getTransform('prop:crate');
      const verticalExtent = Math.abs(Math.sin(crate.angle)) * 24 + Math.abs(Math.cos(crate.angle)) * 12;
      assert.ok(crate.y - verticalExtent >= 370 - 0.6 && crate.y + verticalExtent <= 430 + 0.6,
        `crate crossed corridor wall at tick ${s.tick}: pose=${JSON.stringify(crate)}`);
    }
    assert.ok(world.getTransform('prop:crate').x > startCrate + 100,
      `crate was not pushed: ${startCrate} -> ${world.getTransform('prop:crate').x}`);
    assert.ok(p.x >= 650, `actor did not reach x=650 after pushing: ${p.x}`);
  } finally { disposePhysics(s); }
});
