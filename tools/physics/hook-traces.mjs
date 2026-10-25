/** Reproducible functional traces for the experimental P6 hook and bounded constraints. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhysicsGame, disposePhysics, setInput, snapshot, step, synchronizePhysics } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { physicsRuntime } from '../../shared/simulation/physics-runtime.ts';
import { teleport } from '../../shared/simulation/dev.ts';
import { createPhysicsWorld } from '../../shared/physics/world.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'docs/reports/physics-p6-traces.json'));
const digest = value => createHash('sha256').update(value).digest('hex');
const SEED = 446;

function map(gladiators = 1, gate = false) {
  return { seed: SEED, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: gate
      ? [{ id: 'door', x: 205, y: 400, w: 20, h: 70, kind: 'gate', open: true }] : [],
    hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: gladiators === 2 ? 300 : 250, y: 400 }],
    hunterSpawns: gladiators === 2 ? [{ x: 150, y: 400 }, { x: 450, y: 400 }] : [{ x: 150, y: 400 }] };
}
function content(gladiators = 1) {
  const value = structuredClone(contentById('content-physics-6'));
  value.roster = { contestants: ['C'], gladiators: Array.from({ length: gladiators }, (_, i) => ({ name: `G${i}`, kit: 'hook' })) };
  return value;
}
function frame(s) {
  const runtime = physicsRuntime(s), presented = snapshot(s);
  const ids = s.players.map(p => p.id).sort();
  return { tick: s.tick,
    privateHooks: structuredClone(runtime.hooks),
    public: { hookFlights: presented.hookFlights ?? [], tethers: presented.tethers ?? [] },
    players: ids.map(id => {
      const p = s.players.find(value => value.id === id);
      const body = runtime.world.getTransform(`actor:${id}`);
      return { id, x: p.x, y: p.y, status: p.status, cooldown: p.cooldown,
        vx: body?.vx ?? null, vy: body?.vy ?? null, speed: body ? Math.hypot(body.vx, body.vy) : null };
    }),
    constraints: runtime.world.snapshot().constraints };
}
function press(s, id, fields) {
  assert.ok(setInput(s, id, { seq: s.tick + 1, ...fields }), `input ${id} at ${s.tick}`);
}
async function scenario(name, options, run) {
  const s = await createPhysicsGame(SEED, map(options.gladiators ?? 1, options.gate ?? false),
    content(options.gladiators ?? 1));
  for (const p of s.players) p.bot = false;
  const frames = [frame(s)];
  const tick = () => { step(s); frames.push(frame(s)); };
  const capture = () => { frames.push(frame(s)); };
  try {
    const events = await run({ s, tick, capture });
    return { name, setup: options, events: events ?? [],
      maxPlayerSpeed: Math.max(...frames.flatMap(f => f.players.map(p => p.speed ?? 0))), frames };
  } finally { disposePhysics(s); }
}
async function hookScenarios() {
  return [
    await scenario('stationary-pull-release', {}, ({ s, tick }) => {
      press(s, 'g0', { skill: true, aim: 0 });
      for (let i = 0; i < 12; i++) tick();
      press(s, 'g0', { skill: true }); tick(); tick();
      return [{ afterTick: 12, action: 'second skill press requests release' }];
    }),
    await scenario('moving-victim-steering', {}, ({ s, tick }) => {
      press(s, 'g0', { skill: true, aim: 0 });
      for (let i = 0; i < 20; i++) {
        if (i > 0) press(s, 'c0', { x: 1, y: 0, aim: 0 });
        tick();
      }
      return [{ fromTick: 2, action: 'victim holds rightward movement' }];
    }),
    await scenario('opposing-hooks', { gladiators: 2 }, ({ s, tick }) => {
      press(s, 'g0', { skill: true, aim: 0 });
      press(s, 'g1', { skill: true, aim: Math.PI });
      for (let i = 0; i < 15; i++) tick();
      return [{ beforeTick: 1, action: 'both gladiators launch toward c0' }];
    }),
    await scenario('gate-closes-after-pending-hit', { gate: true }, ({ s, tick, capture }) => {
      press(s, 'g0', { skill: true, aim: 0 }); tick(); tick();
      assert.equal(physicsRuntime(s).hooks[0]?.phase, 'pending');
      s.map.gates[0].open = false;
      synchronizePhysics(s); capture();
      for (let i = 0; i < 3; i++) tick();
      return [{ afterTick: 2, action: 'door closes before attachment boundary' }];
    }),
    await scenario('teleport-cancels', {}, ({ s, tick, capture }) => {
      press(s, 'g0', { skill: true, aim: 0 });
      for (let i = 0; i < 4; i++) tick();
      assert.ok(teleport(s, 'c0', 350, 400));
      synchronizePhysics(s); capture(); tick();
      return [{ afterTick: 4, action: 'target teleported to (350,400)' }];
    }),
    await scenario('miss-away-from-target', {}, ({ s, tick }) => {
      press(s, 'g0', { skill: true, aim: Math.PI });
      for (let i = 0; i < 12; i++) tick();
      return [{ beforeTick: 1, action: 'caster launches left, away from target' }];
    }),
  ];
}

function simpleBody(id, x, options = {}) {
  return { id, kind: 'prop', shape: { kind: 'circle', radius: 2 }, x, y: 0, friction: 0, ...options };
}
async function constraintProbe(name, setup, ticks = 5) {
  const world = await createPhysicsWorld();
  try {
    for (const body of setup.bodies) world.queueAddBody(body);
    for (const constraint of setup.constraints) world.queueAddConstraint(constraint);
    world.commitMutations();
    const frames = [];
    for (let i = 0; i <= ticks; i++) {
      if (i) world.step();
      frames.push({ tick: i, bodies: setup.bodies.map(b => ({ id: b.id, ...world.getTransform(b.id) })),
        constraints: world.snapshot().constraints });
    }
    return { name, setup, frames };
  } finally { world.dispose(); }
}
async function constraintProbes() {
  const base = { id: 'link', a: 'a', b: 'b', maxDistance: 10,
    maxForce: 200, stiffness: 2000, damping: 60 };
  return [
    await constraintProbe('zero-anchor-spring', { bodies: [simpleBody('a', 0), simpleBody('b', 0)],
      constraints: [{ ...base, kind: 'spring', restLength: 0 }] }),
    await constraintProbe('unequal-mass-rope', { bodies: [simpleBody('a', 0, { mass: 1 }), simpleBody('b', 30, { mass: 4 })],
      constraints: [{ ...base, kind: 'rope' }] }),
    await constraintProbe('blocked-finite-rope', { bodies: [simpleBody('a', -20), simpleBody('b', 20),
      { id: 'wall', kind: 'static', shape: { kind: 'box', hx: 2, hy: 40 }, x: 0, y: 0 }],
      constraints: [{ ...base, kind: 'rope', maxDistance: 4, maxForce: 100 }] }, 20),
  ];
}

function verify(scenarios, probes) {
  const byName = Object.fromEntries(scenarios.map(s => [s.name, s]));
  const pulling = s => s.frames.some(f => f.privateHooks.some(h => h.phase === 'pulling'));
  const released = s => s.frames.at(-1).privateHooks.length === 0 && s.frames.at(-1).constraints.length === 0;
  assert.ok(pulling(byName['stationary-pull-release']));
  assert.ok(released(byName['stationary-pull-release']));
  assert.ok(byName['stationary-pull-release'].frames.some(f => f.players.find(p => p.id === 'g0').x > 150));
  assert.ok(byName['stationary-pull-release'].frames.some(f => f.players.find(p => p.id === 'c0').x < 250));
  assert.ok(pulling(byName['moving-victim-steering']));
  assert.ok(byName['moving-victim-steering'].frames.some(f => f.players.find(p => p.id === 'c0').vx > 0));
  assert.ok(byName['opposing-hooks'].frames.some(f => f.privateHooks.filter(h => h.phase === 'pulling').length === 2));
  for (const name of ['gate-closes-after-pending-hit', 'teleport-cancels', 'miss-away-from-target'])
    assert.ok(released(byName[name]), `${name} must clear the tether`);
  const unequal = probes.find(p => p.name === 'unequal-mass-rope').frames[1].bodies;
  assert.ok(Math.abs(unequal.find(b => b.id === 'a').vx + 4 * unequal.find(b => b.id === 'b').vx) < 0.05);
  for (const body of probes.find(p => p.name === 'zero-anchor-spring').frames.flatMap(f => f.bodies))
    assert.ok(Number.isFinite(body.vx) && Number.isFinite(body.vy));
  const blocked = probes.find(p => p.name === 'blocked-finite-rope').frames.at(-1).bodies;
  assert.ok(blocked.find(b => b.id === 'a').x < -3 && blocked.find(b => b.id === 'b').x > 3);
}

const sourcePaths = ['tools/physics/hook-traces.mjs', 'shared/simulation/hook.ts', 'shared/simulation/content.ts',
  'shared/simulation/phased.ts', 'shared/simulation/physics-presentation.ts', 'shared/types.ts',
  'shared/physics/constraints.ts', 'shared/physics/types.ts', 'shared/physics/world.ts'];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, digest(await readFile(path.join(root, file)))])));
const scenarios = await hookScenarios();
const probes = await constraintProbes();
verify(scenarios, probes);
const payload = { scenarios, probes };
const report = { schema: 'physics-p6-functional-traces-1', baseCommit: '6ed90d2', seed: SEED,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release() },
  map: map(), content: content(), physicsSettings: (await (async () => {
    const world = await createPhysicsWorld(); try { return world.settings; } finally { world.dispose(); }
  })()), sourceSha256,
  limitations: ['Functional deterministic scenarios on one Node/platform; no timing or performance claim.',
    'Private hooks are laboratory state; public flights and tethers are unfiltered capture projections.',
    'The tiny rectangular map omits authored room complexity and network visibility filtering.'],
  traceSha256: digest(JSON.stringify(payload)), ...payload };
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`${output}\ntraceSha256 ${report.traceSha256}\n${scenarios.length} hook scenarios, ${probes.length} constraint probes`);
