import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { buildPhysicsGeometry } from '../shared/simulation/physics-geometry.ts';
import { createPhysicsWorld } from '../shared/physics/world.ts';
import { contentById } from '../shared/simulation/content.ts';
import { generateMap } from '../shared/map.ts';

test('the authored 32-unit legacy shortcut still admits contestants and blocks gladiators', async () => {
  const map = generateMap(4217), gap = map.gaps[0];
  assert.ok(gap, 'actual generator supplies the shortcut');
  const specs = buildPhysicsGeometry(map);
  for (const [role, profile] of Object.entries(contentById('content-physics-2').actorPhysics.geometry)) {
    const world = await createPhysicsWorld();
    try {
      for (let i = 0; i < specs.length; i++) {
        world.queueAddBody(specs[i]);
        if (i % 512 === 511) world.commitMutations();
      }
      world.queueAddBody({ id: role, kind: 'actor', x: gap.x - 60, y: gap.y,
        shape: { kind: 'circle', radius: profile.bodyRadius }, friction: 0, restitution: 0 });
      world.commitMutations(); world.setMotor(role, { x: 180, y: 0, accel: 3600 });
      for (let tick = 0; tick < 16; tick++) world.step();
      const end = world.getTransform(role);
      if (role === 'contestant') assert.ok(end.x > gap.x + 30, 'contestant crosses the actual gap');
      else assert.ok(end.x < gap.x - 20, 'gladiator stays on its original side');
    } finally { world.dispose(); }
  }
});

test('narrow actors at the P2 speed cap cannot cross a playable-mask hole', async () => {
  const map = { width: 800, height: 800, obstacles: [], gates: [], playableArea: { cellSize: 100,
    rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: y >= 2 && y < 6 ? [[0, 3], [4, 8]] : [[0, 8]] })) } };
  for (const [role, profile] of Object.entries(contentById('content-physics-2').actorPhysics.geometry)) {
    const world = await createPhysicsWorld();
    try {
      for (const spec of buildPhysicsGeometry(map)) world.queueAddBody(spec);
      world.queueAddBody({ id: role, kind: 'actor', x: 240, y: 400, maxSpeed: 600,
        shape: { kind: 'circle', radius: profile.bodyRadius }, friction: 0, restitution: 0 });
      world.commitMutations(); world.setMotor(role, { x: 600, y: 0, accel: 3600 });
      for (let tick = 0; tick < 20; tick++) {
        const { paths } = world.step();
        for (const p of paths[role]) {
          assert.ok(p.x < 300, 'centre never enters or crosses the void');
          assert.ok(p.x + profile.bodyRadius <= 300.5, 'temporary static penetration stays bounded');
        }
      }
      world.setMotor(role, { x: 0, y: 0, accel: 3600 });
      for (let tick = 0; tick < 4; tick++) world.step();
      assert.ok(world.getTransform(role).x + profile.bodyRadius <= 300.05, 'static penetration recovers');
    } finally { world.dispose(); }
  }
});

test('both narrow role bodies traverse actual authored hut doors in all orientations', async () => {
  const geometry = contentById('content-physics-2').actorPhysics.geometry;
  const sides = new Set();
  // These seeds exercise the production one-space hut authoring and its 80-unit door.
  for (let seed = 1; seed <= 16; seed++) {
    const cells = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6) }));
    const result = buildRegion({ id: 'p2-door', seed, type: 'hut', cellSize: 40, cells,
      zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals: [] });
    const house = result.elements.find(e => e.template.encloses);
    const gate = house.template.parts.find(p => p.part === 'gate');
    assert.equal(Math.max(gate.w, gate.h), 80);
    const vertical = gate.h > gate.w;
    const direction = vertical ? Math.sign(house.template.w / 2 - gate.x) : Math.sign(house.template.h / 2 - gate.y);
    sides.add(`${vertical ? 'x' : 'y'}:${direction}`);
    const centre = { x: house.x + gate.x, y: house.y + gate.y };
    const shapes = result.elements.flatMap(e => elementShapes(e));
    const obstacles = shapes.map((shape, i) => ({ id: `shape-${i}`, ...shape }));
    const map = { width: 240, height: 240, obstacles, gates: [],
      playableArea: { cellSize: 40, rows: Array.from({ length: 6 }, (_, y) => ({ y, runs: [[0, 6]] })) } };
    for (const [role, profile] of Object.entries(geometry)) {
      const world = await createPhysicsWorld();
      try {
        for (const spec of buildPhysicsGeometry(map)) world.queueAddBody(spec);
        const offset = 25;
        const start = { x: centre.x - (vertical ? direction * offset : 0), y: centre.y - (vertical ? 0 : direction * offset) };
        world.queueAddBody({ id: role, kind: 'actor', shape: { kind: 'circle', radius: profile.bodyRadius },
          ...start, mass: 1, friction: 0, restitution: 0 });
        world.commitMutations();
        world.setMotor(role, { x: vertical ? direction * 160 : 0, y: vertical ? 0 : direction * 160, accel: 3600 });
        let distance = 0;
        for (let tick = 0; tick < 7; tick++) distance += world.step().distance[role];
        const end = world.getTransform(role);
        const progress = vertical ? (end.x - centre.x) * direction : (end.y - centre.y) * direction;
        assert.ok(progress > 20, `${seed} ${role} crosses authored opening: ${progress}`);
        assert.ok(Math.abs(distance - (progress + offset)) < 0.01, 'distance records actual straight path');
      } finally { world.dispose(); }
    }
  }
  assert.equal(sides.size, 4, 'all door orientations witnessed');
});

