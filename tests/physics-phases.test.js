import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, createPhysicsGame, disposePhysics, enqueuePhysicsAttachment,
  enqueuePhysicsImpulse, setInput, snapshot, step } from '../shared/simulation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { contentById } from '../shared/simulation/content.ts';

// A full 8 × 8 mask is small enough to expose every contact and phase outcome in a trace.
function fixtureParts(contestants = 2) {
  const map = { seed: 438, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: Array.from({ length: contestants }, (_, i) => ({ x: 150 + i * 70, y: 400 })),
    hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById('content-1'));
  content.roster = { contestants: Array.from({ length: contestants }, (_, i) => `C${i}`), gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

async function pair(contestants = 2) {
  const { map, content } = fixtureParts(contestants);
  const legacy = createGame(438, structuredClone(map), structuredClone(content));
  const physics = await createPhysicsGame(438, structuredClone(map), structuredClone(content));
  for (const s of [legacy, physics]) for (const p of s.players) p.bot = false;
  return { legacy, physics };
}

function input(s, id, fields = {}) {
  assert.ok(setInput(s, id, { seq: s.tick + 1, ...fields }));
}
function trace(s) {
  return { tick: s.tick, players: s.players.map(p => ({ id: p.id, x: p.x, y: p.y, hp: p.hp,
    shield: p.shield, stun: p.stun, charge: p.inventory?.find(i => i?.kind === 'cell')?.charge,
    status: p.status, moved: p.movedThisTick })), items: s.map.items.map(i => i.id),
    bullets: s.projectiles.map(p => p.id) };
}

test('paired trace: bot utility commits in phase 3 and legacy still heals', async () => {
  const { legacy, physics } = await pair(1);
  try {
    for (const s of [legacy, physics]) {
      const p = s.players[0]; p.bot = true; p.hp = 40;
      p.inventory[0] = { kind: 'med', count: 1 }; p.inventory[1] = { kind: 'weapon', weaponType: 'pistol', ammo: 2 };
    }
    step(legacy); step(physics);
    assert.deepEqual([legacy.players[0].hp, physics.players[0].hp], [80, 80], JSON.stringify([trace(legacy), trace(physics)]));
    assert.deepEqual([legacy.players[0].inventory[0], physics.players[0].inventory[0]], [null, null]);
    assert.equal(physics.players[0].selectedSlot, 0);
  } finally { disposePhysics(physics); }
});

test('paired trace: early roster stun acts now in legacy and next tick in physics', async () => {
  const { legacy, physics } = await pair(1);
  try {
    for (const s of [legacy, physics]) {
      const c = s.players[0], g = s.players[1];
      c.x = 300; c.y = 400; g.x = 350; g.y = 400;
      s.players.reverse(); // The warden acts before the contestant in the legacy roster loop.
      input(s, g.id, { skill: true }); input(s, c.id, { x: 1 });
    }
    step(legacy); step(physics);
    const lc = legacy.players.find(p => p.id === 'c0'), pc = physics.players.find(p => p.id === 'c0');
    assert.ok(lc.stun > 0 && pc.stun > 0, JSON.stringify([trace(legacy), trace(physics)]));
    assert.ok(pc.movedThisTick > lc.movedThisTick + 2, JSON.stringify([trace(legacy), trace(physics)]));
    input(physics, pc.id, { x: 1 }); step(physics);
    assert.ok(pc.movedThisTick < 5, JSON.stringify(trace(physics)));
  } finally { disposePhysics(physics); }
});

test('paired trace: blocked input keeps physics charge, while legacy cancels on requested movement', async () => {
  const { legacy, physics } = await pair(1);
  try {
    for (const s of [legacy, physics]) {
      const c = s.players[0]; c.x = 12; c.y = 400;
      c.inventory[0] = { kind: 'cell', charge: 0 }; c.selectedSlot = 0;
      c.charging = 'charger'; s.map.chargers = [{ id: 'charger', x: 40, y: 400 }];
      input(s, c.id, { x: -1 });
    }
    step(legacy); step(physics);
    assert.equal(legacy.players[0].charging, null, JSON.stringify(trace(legacy)));
    assert.equal(physics.players[0].charging, 'charger', JSON.stringify(trace(physics)));
    assert.equal(physics.players[0].inventory[0].charge, 1);
  } finally { disposePhysics(physics); }
});

test('phase 6 contested pickup uses stable actor ID and ignores roster order', async () => {
  const { physics } = await pair(2);
  try {
    const [c0, c1] = physics.players;
    c0.x = 340; c0.y = 400; c1.x = 350; c1.y = 400;
    physics.map.items = [{ id: 'prize', kind: 'med', x: 345, y: 400 }];
    physics.players.reverse();
    step(physics);
    assert.equal(c0.inventory.some(i => i?.kind === 'med'), true, JSON.stringify(trace(physics)));
    assert.equal(c1.inventory.some(i => i?.kind === 'med'), false);
    assert.equal(physics.map.items.length, 0);
  } finally { disposePhysics(physics); }
});

test('phase 6 impulse movement can trigger a mine after charging and pickup', async () => {
  const { physics } = await pair(1);
  try {
    const c = physics.players[0]; c.x = 300; c.y = 400;
    physics.map.items = [{ id: 'med', kind: 'med', x: 300, y: 400 }];
    physics.map.traps = [{ id: 'mine', kind: 'mine', x: 300, y: 400, homeX: 300, homeY: 400,
      heading: 0, offset: 0, cooldown: 0, spent: false }];
    enqueuePhysicsImpulse(physics, `actor:${c.id}`, { x: 100, y: 0 });
    step(physics);
    assert.ok(c.movedThisTick > 0.5, JSON.stringify(trace(physics)));
    assert.equal(c.inventory.some(i => i?.kind === 'med'), true);
    assert.equal(physics.map.traps[0].spent, true);
    assert.equal(c.hp, 55);
  } finally { disposePhysics(physics); }
});

test('phase 5 lethal projectile prevents the victim from collecting in phase 6', async () => {
  const { physics } = await pair(1);
  try {
    const c = physics.players[0], g = physics.players[1];
    c.x = 300; c.y = 400; c.hp = 5;
    g.x = 600; g.y = 400;
    physics.map.items = [{ id: 'left-behind', kind: 'med', x: 300, y: 400 }];
    physics.projectiles.push({ id: 10, owner: g.id, x: 280, y: 400,
      dx: 40, dy: 0, damage: 10, life: 5 });
    step(physics);
    assert.equal(c.status, 'eliminated', JSON.stringify(trace(physics)));
    assert.equal(physics.map.items.some(i => i.id === 'left-behind'), true);
    assert.equal(c.inventory.some(Boolean), false);
  } finally { disposePhysics(physics); }
});

test('phase 6 actual push distance cancels charging even without requested movement', async () => {
  const { physics } = await pair(1);
  try {
    const c = physics.players[0]; c.x = 300; c.y = 400;
    c.inventory[0] = { kind: 'cell', charge: 4 }; c.charging = 'charger';
    physics.map.chargers = [{ id: 'charger', x: 300, y: 400 }];
    enqueuePhysicsImpulse(physics, `actor:${c.id}`, { x: 100, y: 0 });
    step(physics);
    assert.ok(c.movedThisTick > 0.5, JSON.stringify(trace(physics)));
    assert.equal(c.charging, null);
    assert.equal(c.inventory[0].charge, 4);
  } finally { disposePhysics(physics); }
});

test('paired trace: finalized melee death precedes physics pickup, unlike an earlier legacy roster turn', async () => {
  const { legacy, physics } = await pair(1);
  try {
    for (const s of [legacy, physics]) {
      const c = s.players[0], g = s.players[1];
      c.x = 300; c.y = 400; c.hp = 10;
      g.x = 350; g.y = 400;
      s.map.items = [{ id: 'before-death', kind: 'med', x: 300, y: 400 }];
      input(s, g.id, { attack: true, aim: Math.PI });
    }
    step(legacy); step(physics);
    assert.equal(legacy.players[0].status, 'eliminated', JSON.stringify(trace(legacy)));
    assert.equal(physics.players[0].status, 'eliminated', JSON.stringify(trace(physics)));
    assert.equal(legacy.map.items.some(i => i.id === 'before-death'), false);
    assert.equal(physics.map.items.some(i => i.id === 'before-death'), true);
  } finally { disposePhysics(physics); }
});

test('equal-time opposing projectile impacts resolve once each after reversed roster collection', async () => {
  const { physics } = await pair(2);
  try {
    const [c0, c1] = physics.players;
    c0.x = 300; c0.y = 400; c0.hp = 5;
    c1.x = 335; c1.y = 400; c1.hp = 5;
    for (const c of [c0, c1]) c.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1 };
    physics.players.reverse();
    input(physics, c0.id, { attack: true, aim: 0 });
    input(physics, c1.id, { attack: true, aim: Math.PI });
    step(physics);
    assert.equal(c0.status, 'eliminated', JSON.stringify(trace(physics)));
    assert.equal(c1.status, 'eliminated', JSON.stringify(trace(physics)));
    assert.equal(physics.projectiles.length, 0);
    assert.equal(physics.map.items.filter(i => i.kind === 'weapon' && i.droppedBy).length, 2);
  } finally { disposePhysics(physics); }
});

test('actor bullet advances once on its admission tick and sweeps a moving target', async () => {
  const miss = await pair(1);
  const hit = await pair(2);
  try {
    const shooter = miss.physics.players[0]; shooter.x = 300; shooter.y = 400;
    shooter.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1 };
    input(miss.physics, shooter.id, { attack: true, aim: 0 });
    step(miss.physics);
    assert.equal(miss.physics.projectiles.length, 1);
    assert.ok(Math.abs(miss.physics.projectiles[0].x - 335) < 1e-6,
      JSON.stringify(trace(miss.physics))); // A second projectile owner would move it to 370.

    const [from, target] = hit.physics.players;
    from.x = 300; from.y = 400;
    target.x = 335; target.y = 380;
    from.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1 };
    input(hit.physics, from.id, { attack: true, aim: 0 });
    input(hit.physics, target.id, { y: 1 });
    step(hit.physics);
    assert.ok(target.movedThisTick > 0, JSON.stringify(trace(hit.physics)));
    assert.equal(target.hp, 90, JSON.stringify(trace(hit.physics)));
    assert.equal(hit.physics.projectiles.length, 0);
  } finally { disposePhysics(miss.physics); disposePhysics(hit.physics); }
});

test('phase 6 turret spawn waits in the next boundary queue', async () => {
  const { physics } = await pair(1);
  try {
    physics.map.traps = [{ id: 'turret', kind: 'turret', x: 260, y: 400, homeX: 260, homeY: 400,
      heading: 0, offset: 0, cooldown: 0, spent: false }];
    step(physics);
    assert.equal(physics.projectiles.length, 0);
    assert.equal(physicsRuntime(physics).pendingSpawns.length, 1);
    step(physics);
    assert.equal(physicsRuntime(physics).pendingSpawns.length, 0);
    assert.ok(physics.projectiles.length <= 1);
  } finally { disposePhysics(physics); }
});

test('pending impulse and attachment are captured, applied once, then consumed', async () => {
  const { physics } = await pair(2);
  try {
    const [a, b] = physics.players;
    a.x = 300; a.y = 350; b.x = 360; b.y = 350;
    enqueuePhysicsImpulse(physics, `actor:${a.id}`, { x: 100, y: 0 });
    enqueuePhysicsAttachment(physics, { id: 'rope', a: `actor:${a.id}`, b: `actor:${b.id}`, maxDistance: 80 });
    const before = snapshot(physics);
    assert.equal(before.physics.pendingImpulses.length, 1);
    assert.equal(before.physics.pendingAttachments.length, 1);
    step(physics);
    assert.equal(physicsRuntime(physics).pendingImpulses.length, 0);
    assert.equal(physicsRuntime(physics).pendingAttachments.length, 0);
    assert.equal(physicsRuntime(physics).world.counts().constraints, 1);
    assert.ok(a.movedThisTick > 0);
  } finally { disposePhysics(physics); }
});

test('attachment admission rejects an endpoint eliminated before the next boundary', async () => {
  const { physics } = await pair(2);
  try {
    const [a, b] = physics.players;
    enqueuePhysicsAttachment(physics, { id: 'too-late', a: `actor:${a.id}`,
      b: `actor:${b.id}`, maxDistance: 80 });
    b.status = 'eliminated';
    step(physics);
    assert.equal(physicsRuntime(physics).world.counts().constraints, 0);
    assert.equal(physicsRuntime(physics).pendingAttachments.length, 0);
  } finally { disposePhysics(physics); }
});

test('fresh physics worlds replay the same full-state trace exactly', async () => {
  const { map, content } = fixtureParts(1);
  const first = await createPhysicsGame(438, structuredClone(map), structuredClone(content));
  const second = await createPhysicsGame(438, structuredClone(map), structuredClone(content));
  try {
    for (const s of [first, second]) for (const p of s.players) p.bot = false;
    for (let tick = 0; tick < 8; tick++) {
      for (const s of [first, second]) { input(s, 'c0', { x: 1 }); step(s); }
      assert.deepEqual(snapshot(first), snapshot(second), `tick ${tick + 1}`);
    }
  } finally { disposePhysics(first); disposePhysics(second); }
});
