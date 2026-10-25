import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsGame, disposePhysics, setInput, step, synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { teleport } from '../shared/simulation/dev.ts';

function fixture(contestants = 1) {
  const map = { seed: 439, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: Array.from({ length: contestants }, (_, i) => ({ x: 250 + i * 80, y: 400 })),
    hunterSpawns: [{ x: 150, y: 400 }] };
  const content = structuredClone(contentById('content-physics-6'));
  content.roster = { contestants: Array.from({ length: contestants }, (_, i) => `C${i}`),
    gladiators: [{ name: 'G', kit: 'hook' }] };
  return { map, content };
}

async function game(parts = fixture()) {
  const s = await createPhysicsGame(439, parts.map, parts.content);
  for (const p of s.players) p.bot = false;
  return s;
}

const player = (s, id) => s.players.find(p => p.id === id);
const hooks = s => physicsRuntime(s).hooks;
const world = s => physicsRuntime(s).world;
const press = (s, id, fields) => assert.ok(setInput(s, id, { seq: s.tick + 1, ...fields }));
const advance = (s, count) => { for (let i = 0; i < count; i++) step(s); };

test('P6 hook is opt-in, launches once, misses at range and spends cooldown', async () => {
  const s = await game();
  try {
    assert.equal(s.version, 'last-exit-0.8-physics-6');
    press(s, 'g0', { skill: true, aim: Math.PI }); step(s);
    assert.equal(player(s, 'g0').cooldown, s.content.hook.cooldownTicks);
    assert.equal(hooks(s).length, 1);
    advance(s, 12);
    assert.equal(hooks(s).length, 0);
    assert.equal(world(s).counts().constraints, 0);
    press(s, 'g0', { skill: true, aim: 0 }); step(s);
    assert.equal(hooks(s).length, 0, 'cooldown prevents relaunch');
  } finally { disposePhysics(s); }
});

test('a swept hit attaches at the next boundary and has equal/opposite response', async () => {
  const s = await game();
  try {
    press(s, 'g0', { skill: true, aim: 0 }); step(s);
    assert.equal(hooks(s)[0]?.phase, 'flying');
    step(s);
    assert.equal(hooks(s)[0]?.phase, 'pending');
    assert.equal(world(s).counts().constraints, 0);
    const before = { caster: player(s, 'g0').x, target: player(s, 'c0').x };
    step(s);
    assert.equal(hooks(s)[0]?.phase, 'pulling');
    assert.equal(world(s).counts().constraints, 1);
    assert.ok(player(s, 'g0').x > before.caster);
    assert.ok(player(s, 'c0').x < before.target);
    const firstLength = world(s).snapshot().constraints[0].maxDistance;
    step(s);
    assert.equal(world(s).counts().constraints, 1);
    assert.ok(world(s).snapshot().constraints[0].maxDistance < firstLength, 'rope target shortens on later ticks');
    assert.equal(s.content.hook.maxForce, 6000);
  } finally { disposePhysics(s); }
});

test('the first intervening actor blocks the hook and friendly actors cannot attach', async () => {
  const s = await game(fixture(2));
  try {
    assert.ok(teleport(s, 'c1', 220, 400));
    press(s, 'g0', { skill: true, aim: 0 }); step(s); step(s);
    assert.equal(hooks(s)[0]?.target, 'c1');
    assert.notEqual(hooks(s)[0]?.target, 'c0');
  } finally { disposePhysics(s); }
  const friendly = await game();
  try {
    const extra = { ...player(friendly, 'g0'), id: 'g1', x: 200, cooldown: 0 };
    friendly.players.push(extra);
    synchronizePhysics(friendly);
    press(friendly, 'g0', { skill: true, aim: 0 }); step(friendly); step(friendly);
    assert.equal(hooks(friendly).length, 0);
  } finally { disposePhysics(friendly); }
});

test('gate closure blocks flight and a second press cancels without bypassing cooldown', async () => {
  const parts = fixture();
  parts.map.gates = [{ id: 'door', x: 205, y: 400, w: 20, h: 70, kind: 'gate', open: false }];
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 }); step(s); step(s);
    assert.equal(hooks(s).length, 0);
    assert.equal(world(s).counts().constraints, 0);
  } finally { disposePhysics(s); }
  const c = await game();
  try {
    press(c, 'g0', { skill: true, aim: 0 }); step(c); step(c); step(c);
    assert.equal(hooks(c)[0]?.phase, 'pulling');
    press(c, 'g0', { skill: true }); step(c);
    assert.equal(hooks(c).length, 0);
    assert.equal(world(c).counts().constraints, 0);
    assert.ok(player(c, 'g0').cooldown > 0);
  } finally { disposePhysics(c); }
});

test('closing a gate across an attached tether releases it before the next solve', async () => {
  const parts = fixture();
  parts.map.gates = [{ id: 'door', x: 205, y: 400, w: 20, h: 70, kind: 'gate', open: true }];
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 }); advance(s, 3);
    assert.equal(hooks(s)[0]?.phase, 'pulling');
    assert.equal(world(s).counts().constraints, 1);
    s.map.gates[0].open = false;
    synchronizePhysics(s);
    assert.equal(s.map.gates[0].open, false);
    assert.equal(hooks(s).length, 0);
    assert.equal(world(s).counts().constraints, 0);
  } finally { disposePhysics(s); }
});

test('a gate closed after hit prevents next-boundary attachment', async () => {
  const parts = fixture();
  parts.map.gates = [{ id: 'door', x: 205, y: 400, w: 20, h: 70, kind: 'gate', open: true }];
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 }); step(s); step(s);
    assert.equal(hooks(s)[0]?.phase, 'pending');
    s.map.gates[0].open = false; synchronizePhysics(s);
    assert.equal(hooks(s).length, 0);
    step(s);
    assert.equal(world(s).counts().constraints, 0);
  } finally { disposePhysics(s); }
});

test('the hook tip stops at playable-mask void geometry', async () => {
  const parts = fixture();
  parts.map.spawns[0].x = 450;
  parts.map.playableArea.rows = parts.map.playableArea.rows.map(row => ({ ...row, runs: [[0, 3], [4, 8]] }));
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 }); advance(s, 8);
    assert.equal(hooks(s).length, 0);
    assert.equal(world(s).counts().constraints, 0);
  } finally { disposePhysics(s); }
});

test('a solid prop moved across a tether releases it', async () => {
  const s = await game();
  try {
    press(s, 'g0', { skill: true, aim: 0 }); advance(s, 3);
    assert.equal(hooks(s)[0]?.phase, 'pulling');
    const w = world(s);
    w.queueAddBody({ id: 'prop:block', kind: 'prop', shape: { kind: 'box', hx: 10, hy: 15 },
      x: 400, y: 400, mass: 1 });
    w.commitMutations();
    w.setTransform('prop:block', { x: 205, y: 400, angle: 0 });
    synchronizePhysics(s);
    assert.equal(hooks(s).length, 0);
    assert.equal(w.counts().constraints, 0);
  } finally { disposePhysics(s); }
});

test('opposing casters can attach to the same enemy without corrupting either tether', async () => {
  const parts = fixture();
  parts.map.spawns[0].x = 350;
  parts.map.hunterSpawns = [{ x: 150, y: 400 }, { x: 550, y: 400 }];
  parts.content.roster.gladiators.push({ name: 'H', kit: 'hook' });
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 });
    press(s, 'g1', { skill: true, aim: Math.PI });
    advance(s, 6);
    assert.deepEqual(hooks(s).map(hook => [hook.caster, hook.target, hook.phase]),
      [['g0', 'c0', 'pulling'], ['g1', 'c0', 'pulling']]);
    assert.equal(world(s).counts().constraints, 2);
    const at = player(s, 'c0');
    assert.ok(Number.isFinite(at.x) && at.x > 300 && at.x < 400);
  } finally { disposePhysics(s); }
});

test('simultaneous pending hits lose newly occupied constraint slots gracefully', async () => {
  const parts = fixture();
  parts.map.spawns[0].x = 350;
  parts.map.hunterSpawns = [{ x: 150, y: 400 }, { x: 550, y: 400 }];
  parts.content.roster.gladiators.push({ name: 'H', kit: 'hook' });
  const s = await game(parts);
  try {
    press(s, 'g0', { skill: true, aim: 0 });
    press(s, 'g1', { skill: true, aim: Math.PI });
    advance(s, 5);
    assert.deepEqual(hooks(s).map(h => h.phase), ['pending', 'pending']);
    for (let i = 0; i < 7; i++) world(s).queueAddConstraint({ id: `other:${i}`,
      a: 'actor:g0', b: 'actor:c0', maxDistance: 1000 });
    world(s).commitMutations();
    assert.doesNotThrow(() => step(s));
    assert.equal(world(s).counts().constraints, 8);
    assert.equal(hooks(s).length, 1);
    assert.equal(hooks(s)[0].caster, 'g0', 'stable caster order wins the remaining slot');
  } finally { disposePhysics(s); }
});

test('near pulls release at standoff; range-edge pull stays bounded through timeout', async () => {
  for (const separation of [100, 300, 500]) {
    const parts = fixture();
    parts.map.spawns[0].x = 150 + separation;
    const s = await game(parts);
    try {
      press(s, 'g0', { skill: true, aim: 0 });
      let closest = separation;
      let releaseTick = null;
      for (let i = 0; i <= s.content.hook.durationTicks; i++) {
        const attached = hooks(s).some(hook => hook.phase === 'pulling');
        step(s);
        closest = Math.min(closest, Math.abs(player(s, 'c0').x - player(s, 'g0').x));
        if (attached && hooks(s).length === 0 && releaseTick === null) releaseTick = s.tick;
      }
      if (separation < 500) {
        assert.ok(closest <= s.content.hook.standoff, `${separation}: closest ${closest}`);
        assert.ok(releaseTick < s.content.hook.durationTicks, `${separation}: release tick ${releaseTick}`);
      } else assert.ok(Number.isFinite(closest) && closest < separation, `range-edge closest ${closest}`);
      assert.equal(hooks(s).length, 0, `${separation}: standoff or lifetime leaves no tether`);
      assert.equal(world(s).counts().constraints, 0);
    } finally { disposePhysics(s); }
  }
});

test('victim steering remains active while a bounded pull contests it', async () => {
  const s = await game();
  try {
    press(s, 'g0', { skill: true, aim: 0 });
    let closest = 100;
    for (let i = 0; i < 10; i++) {
      if (i > 0) press(s, 'c0', { x: 1 });
      step(s);
      closest = Math.min(closest, player(s, 'c0').x - player(s, 'g0').x);
    }
    assert.equal(hooks(s)[0]?.phase, 'pulling');
    const target = world(s).snapshot().bodies.find(body => body.spec.id === 'actor:c0');
    assert.ok(target.motor.x > 0, 'the victim keeps its movement motor');
    assert.ok(closest < 100 && closest > s.content.hook.standoff, `closest ${closest}`);
    assert.ok(Math.abs(target.transform.vx) <= s.content.actorPhysics.maxSpeed);
  } finally { disposePhysics(s); }
});

test('teleport, death, and reversed roster remove or deterministically retain hook state', async () => {
  const a = await game(), b = await game();
  try {
    b.players.reverse();
    for (const s of [a, b]) { press(s, 'g0', { skill: true, aim: 0 }); advance(s, 3); }
    assert.deepEqual(hooks(a), hooks(b));
    assert.ok(teleport(a, 'c0', 350, 400));
    synchronizePhysics(a);
    assert.equal(hooks(a).length, 0);
    assert.equal(world(a).counts().constraints, 0);
    player(b, 'c0').status = 'eliminated'; synchronizePhysics(b);
    assert.equal(hooks(b).length, 0);
    assert.equal(world(b).counts().constraints, 0);
  } finally { disposePhysics(a); disposePhysics(b); }
});

test('endpoint status, caster teleport and lost joint release at reconciliation', async () => {
  for (const change of ['caster death', 'target extraction', 'caster teleport', 'lost joint']) {
    const s = await game();
    try {
      press(s, 'g0', { skill: true, aim: 0 }); advance(s, 3);
      assert.equal(hooks(s)[0]?.phase, 'pulling');
      if (change === 'caster death') player(s, 'g0').status = 'eliminated';
      else if (change === 'target extraction') player(s, 'c0').status = 'escaped';
      else if (change === 'caster teleport') assert.ok(teleport(s, 'g0', 100, 500));
      else { world(s).queueRemoveConstraint(hooks(s)[0].id); world(s).commitMutations(); }
      synchronizePhysics(s);
      assert.equal(hooks(s).length, 0, change);
      assert.equal(world(s).counts().constraints, 0, change);
    } finally { disposePhysics(s); }
  }
});
