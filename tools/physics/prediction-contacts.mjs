// #1142: paired production predictor contact witness. Synthetic ordered tick deliveries.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGame, disposePhysics, playerView, setInput, snapshot, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { createPhysicsPrediction } from '../../public/physics-prediction.js';
import { arena } from '../../tests/helpers/arena.js';
import { readArena, ARENA_FILE } from '../room-arena.mjs';

const variants = ['exact', 'repeat', 'own-player', 'own-body', 'proxies', 'xy-only', 'angle-only', 'velocity-only', 'omega-only', 'all'];
const variantNumericFields = {
  'xy-only': ['x','y'],
  'angle-only': ['heading','angle'],
  'velocity-only': ['vx','vy'],
  'omega-only': ['omega'],
};
const ownershipFields = {
  'own-player': ['x','y','heading'],
  'own-body': ['x','y','angle','vx','vy','omega'],
  proxies: ['x','y','angle','vx','vy','omega'],
};
const profiles = [
  { name: 'rotated-prop', delay: 1, prop: true },
  { name: 'moving-actor', delay: 1, actor: true },
  { name: 'seed9', delay: 1, seed9: true },
  { name: 'rtt-0', delay: 0 }, { name: 'rtt-100', delay: 1 }, { name: 'rtt-200', delay: 2 },
  { name: 'frame-gap', delay: 1, gap: true }, { name: 'stale', delay: 1, stale: true },
  { name: 'placement', delay: 1, placement: true }, { name: 'generation', delay: 1, generation: true },
  { name: 'tethered', delay: 1, tethered: true },
];
const quanta = { x: 1/256, y: 1/256, vx: 1/256, vy: 1/256, angle: 2*Math.PI/65536, heading: 2*Math.PI/65536, omega: 1/4096 };
const budget = 2/512;
const numericFieldsForVariant = variant => variantNumericFields[variant] ?? [];
function quantize(frame, variant, tally) {
  const result = structuredClone(frame);
  const apply = (record, fields, family) => {
    for (const key of fields) if (typeof record[key] === 'number') {
      const old = record[key], q = quanta[key], rounded = Math.round(old / q) * q, error = Math.abs(rounded - old);
      assert.ok(error <= q/2 + 1e-12, `${family}.${key} exceeds half quantum`);
      const stat = tally[`${family}.${key}`] ??= { seen: 0, changed: 0, maxError: 0 };
      stat.seen++; if (rounded !== old) stat.changed++; stat.maxError = Math.max(stat.maxError, error);
      record[key] = rounded;
    }
  };
  const numericFields = numericFieldsForVariant(variant);
  const fields = list => numericFields.length ? list.filter(key => numericFields.includes(key)) : list;
  if (variant === 'own-player' || variant === 'all' || numericFields.length) {
    const player = result.players.find(p => p.id === 'c0');
    if (player) apply(player, fields(ownershipFields['own-player']), 'own-player');
  }
  for (const body of result.bodies ?? []) {
    if (body.actorId === 'c0' && (variant === 'own-body' || variant === 'all' || numericFields.length)) apply(body, fields(ownershipFields['own-body']), 'own-body');
    else if (body.actorId !== 'c0' && body.itemId === undefined && (variant === 'proxies' || variant === 'all' || numericFields.length)) apply(body, fields(ownershipFields.proxies), 'proxies');
  }
  return result;
}
const selectedFields = variant => {
  if (variant === 'exact' || variant === 'repeat') return [];
  const families = variant === 'own-player' ? ['own-player'] : variant === 'own-body' ? ['own-body'] : variant === 'proxies' ? ['proxies'] : Object.keys(ownershipFields);
  const numericFields = numericFieldsForVariant(variant);
  return families.flatMap(family => ownershipFields[family]
    .filter(field => variant === 'all' || variant === family || numericFields.includes(field))
    .map(field => `${family}.${field}`));
};
const percentile = (xs, p) => { const a = [...xs].sort((x,y) => x-y); return a[Math.max(0, Math.ceil(a.length*p)-1)] ?? 0; };
function fixture(profile) {
  if (profile.seed9) return readArena().map;
  return arena({ cols: 8, rows: 6, cellSize: 100, seed: 441,
    spawns: [{ x: 150.13, y: 300.17 }, { x: profile.actor ? 220.29 : 700, y: 300.23 }],
    hunterSpawns: [{ x: 700, y: 500 }],
    physicsProps: profile.prop ? [{ id: 'rotated', profile: 'crate', x: 235.19, y: 300.31, angle: 0.35 }] : [],
    obstacles: [{ id: 'wall', x: 600, y: 100, w: 16, h: 400 }] }).map;
}
async function run(profile) {
  const map = fixture(profile), content = structuredClone(contentById('content-7'));
  content.roster = { contestants: ['Self', 'Other'], gladiators: [{ name: 'G', kit: 'warden' }] };
  const game = await createGame(profile.seed9 ? 9 : 441, map, content);
  for (const player of game.players) player.bot = false;
  let now = 0, seq = 0, order = 0;
  const pending = [], runs = {};
  const enqueue = (time, fn) => pending.push({ time, order: order++, fn });
  for (const variant of variants) {
    const run = runs[variant] = { tally: {}, operations: [], steps: [], corrections: [], proxies: {} };
    run.predictor = await createPhysicsPrediction(game.map, 'c0', { clock: () => now, observeStep: s => run.steps.push(s) });
  }
  function operation(kind, payload) {
    for (const variant of variants) {
      const r = runs[variant], frame = kind === 'correct' ? quantize(payload, variant, r.tally) : payload;
      if (kind === 'correct') for (const b of frame.bodies ?? []) if (b.actorId !== 'c0' && b.itemId === undefined) {
        const p = r.proxies[b.id] ??= { count: 0, firstPose: { x: b.x, y: b.y, angle: b.angle }, maxPositionDelta: 0, maxAbsAngle: 0, anglePerturbations: 0 };
        p.count++; p.maxAbsAngle = Math.max(p.maxAbsAngle, Math.abs(b.angle));
        p.maxPositionDelta = Math.max(p.maxPositionDelta, Math.hypot(b.x-p.firstPose.x, b.y-p.firstPose.y));
        const original = payload.bodies.find(body => body.id === b.id);
        if (original && b.angle !== original.angle) p.anglePerturbations++;
      }
      const start = r.steps.length;
      r.predictor[kind](frame);
      const state = r.predictor.stats(), pose = r.predictor.value();
      r.operations.push({ kind, tick: kind === 'correct' ? payload.tick : null, seq: kind === 'input' ? payload.seq : null,
        pose: pose && { x: pose.x, y: pose.y }, reason: state.reason, error: state.error, steps: r.steps.slice(start) });
      if (kind === 'correct' && Number.isFinite(state.error)) r.corrections.push(state.error);
    }
  }
  function deliver(frame) {
    const f = structuredClone(frame), own = f.bodies.find(b => b.actorId === 'c0');
    if (profile.placement && f.tick === 22) own.discontinuity = true;
    if (profile.generation && f.tick >= 22) own.generation++;
    if (profile.tethered && f.tick === 22) f.predictionTethered = true;
    operation('correct', f);
  }
  try {
    deliver(playerView(game, snapshot(game), 'c0'));
    for (let tick = 1; tick <= 80; tick++) {
      const time = tick * 50;
      enqueue(time, () => {
        if (profile.stale && tick >= 20 && tick <= 33) return;
        // The synthetic input arrives before its scheduled authority tick; this is not a clock model.
        const input = { seq: seq++, tick: tick + profile.delay + 1, x: tick < 70 ? 1 : 0, y: profile.prop ? 0.08 : 0, sneak: false };
        operation('input', input);
        enqueue(now + profile.delay * 50, () => setInput(game, 'c0', input));
      });
      enqueue(time + 1, () => {
        if (profile.actor) setInput(game, 'c1', { seq: tick, x: tick < 35 ? -0.4 : 0, y: tick < 35 ? 0.15 : 0, sneak: false });
        step(game);
        if ((profile.gap && tick >= 20 && tick <= 24) || (profile.stale && tick >= 20 && tick <= 33)) return;
        const frame = playerView(game, snapshot(game), 'c0');
        enqueue(now + profile.delay * 50, () => deliver(frame));
      });
    }
    while (pending.length) { pending.sort((a,b) => a.time-b.time || a.order-b.order); const event = pending.shift(); now = event.time; event.fn(); }
    const base = runs.exact;
    const results = {};
    for (const variant of variants) {
      const r = runs[variant]; let maxPose = 0, availabilityDifferences = 0, cutDifferences = 0, contactDifferences = 0;
      assert.equal(r.operations.length, base.operations.length);
      for (let i = 0; i < r.operations.length; i++) {
        const a = base.operations[i], b = r.operations[i];
        if (!!a.pose !== !!b.pose) availabilityDifferences++;
        if (a.reason !== b.reason) cutDifferences++;
        if (a.pose && b.pose) maxPose = Math.max(maxPose, Math.hypot(a.pose.x-b.pose.x, a.pose.y-b.pose.y));
        for (let j = 0; j < Math.max(a.steps.length, b.steps.length); j++) {
          const x = a.steps[j], y = b.steps[j];
          if (JSON.stringify(x && [x.tick,x.seq,x.context,x.contacts]) !== JSON.stringify(y && [y.tick,y.seq,y.context,y.contacts])) contactDifferences++;
        }
      }
      const p99Rise = percentile(r.corrections,.99)-percentile(base.corrections,.99), maxRise = percentile(r.corrections,1)-percentile(base.corrections,1);
      const events = r.steps.flatMap(s => s.contacts.map(c => ({ ...c, tick: s.tick, seq: s.seq, context: s.context })));
      const reasons = Object.fromEntries([...new Set(r.operations.map(o => o.reason).filter(Boolean))].map(reason => [reason, r.operations.filter(o => o.reason === reason).length]));
      const coverage = { steps: r.steps.length, replaySteps: r.steps.filter(s => s.context === 'replay').length,
        events, proxies: r.proxies, reasons };
      const perturbedFields = Object.entries(r.tally).filter(([,v]) => v.changed).map(([key]) => key);
      const selected = selectedFields(variant);
      const unexercisedFields = selected.filter(key => !r.tally[key]?.changed);
      const passed = maxPose <= budget && p99Rise <= budget && maxRise <= budget && !availabilityDifferences && !cutDifferences && !contactDifferences;
      results[variant] = { maxPose, p99Rise, maxRise, availabilityDifferences, cutDifferences, contactDifferences, passed, coverageComplete: unexercisedFields.length === 0, perturbedFields, unexercisedFields, tally: r.tally, coverage };
    }
    assert.deepEqual(base.operations, runs.repeat.operations, `${profile.name}: exact repeat`);
    const coverage = results.exact.coverage;
    const contact = id => coverage.events.some(e => e.a === id || e.b === id);
    if (profile.prop) {
      const proxy = coverage.proxies['prop:rotated'];
      assert.ok(proxy && proxy.maxAbsAngle > 0.01, 'rotated prop delivered');
      assert.ok(contact('proxy:prop:rotated'), 'rotated prop actually contacted in predictor');
      assert.ok(coverage.events.some(e => e.context === 'replay' && (e.a === 'proxy:prop:rotated' || e.b === 'proxy:prop:rotated')), 'rotated prop replay contact');
      assert.ok(results.proxies.coverage.proxies['prop:rotated'].anglePerturbations > 0, 'contacted prop angle perturbed');
    }
    if (profile.actor) {
      const proxy = coverage.proxies['actor:c1'];
      assert.ok(proxy && proxy.maxPositionDelta > 0.01, 'moving actor delivered');
      assert.ok(contact('proxy:actor:c1'), 'moving actor actually contacted in predictor');
      assert.ok(coverage.events.some(e => e.context === 'replay' && (e.a === 'proxy:actor:c1' || e.b === 'proxy:actor:c1')), 'moving actor replay contact');
    }
    if (profile.seed9) assert.ok(coverage.events.some(e => e.a.startsWith('obstacle:') || e.b.startsWith('obstacle:')), 'seed9 static geometry contact');
    for (const [flag, reason] of [['gap','frame-gap'],['stale','stale-authority'],['placement','placement'],['generation','profile-or-generation'],['tethered','tethered']])
      if (profile[flag]) assert.ok(coverage.reasons[reason], `${profile.name}: ${reason} cut`);
    for (const [flag, reason] of [['placement','placement'],['generation','profile-or-generation'],['tethered','tethered']])
      if (profile[flag]) assert.ok(base.operations.some(o => o.kind === 'correct' && o.tick === 22 && o.reason === reason), `${flag}: injected cut at tick 22`);
    return results;
  } finally { for (const r of Object.values(runs)) r.predictor.dispose(); disposePhysics(game); }
}
const files = ['tools/physics/prediction-contacts.mjs','public/physics-prediction.js','public/physics-prediction-limits.js','shared/physics/world.ts','shared/physics/motion-limits.ts','shared/physics/presentation-geometry.ts','shared/movement.ts','shared/simulation.ts','shared/simulation/game.ts','shared/simulation/tick.ts','shared/simulation/state.ts','shared/simulation/input.ts','shared/simulation/physics-geometry.ts','shared/simulation/physics-runtime.ts','shared/simulation/visibility.ts','shared/simulation/actor-physics.ts','shared/simulation/content.ts','tests/helpers/arena.js','tools/room-arena.mjs',ARENA_FILE,'package-lock.json','node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm'];
const report = { witness: '#1142 predictor contact quantization', date: new Date().toISOString(), commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  hashes: Object.fromEntries(files.map(f => [f,createHash('sha256').update(readFileSync(f)).digest('hex')])),
  node: process.version, quanta,
  settings: { tickMs: 50, ticks: 80, content: 'content-7', authoredSeed: 441, generatedSeed: 9,
    generatedArena: ARENA_FILE, profiles, variants,
    delivery: 'one-way input and correction delay = profile.delay * 50 ms; FIFO ordered events',
    stamps: 'input tick = synthetic send tick + profile.delay + 1; no client clock model',
    sampling: 'after every input/correction operation; contacts after every new-input and replay solver step',
    controls: 'exact and repeat receive identical unrounded projections from the same authoritative game',
    events: 'Each profile stores exact.coverage.events in full; other variants store eventsRef = exact.coverage.events when their event arrays deeply match, otherwise their own full events array.',
    hashes: 'SHA-256 of working-tree bytes; commit pins repository sources, including line-ending normalization' },
  budget: { maxPairedPose: budget, maxP99AndMaxCorrectionErrorRise: budget, availabilityAndCutDifferences: 0, contactEventStepDifferences: 0 },
  limitations: ['Synthetic ordered tick deliveries; no socket or browser scheduling. Existing jitter, reconnect, background, hidden-contact, stale-door and burst profiles are not reproduced.', 'Fallbacks are injected into production projections; generated geometry uses the stored seed 9 map.', 'Proxy lists record delivered candidates, while contact IDs demonstrate actual island inclusion.', 'Qualification requires every profile to pass and every selected field to be perturbed somewhere in the workload. Proxies are fixed, so their velocity and omega are not consumed by the predictor; own body omega and player heading are also not consumed by the motor solve.'], results: {} };
for (const profile of profiles) report.results[profile.name] = await run(profile);
report.summary = Object.fromEntries(variants.map(variant => {
  const results = profiles.map(profile => [profile.name, report.results[profile.name][variant]]);
  const perturbedFields = [...new Set(results.flatMap(([,result]) => result.perturbedFields))];
  const unexercisedFields = selectedFields(variant).filter(field => !perturbedFields.includes(field));
  const failingProfiles = results.filter(([,result]) => !result.passed).map(([name]) => name);
  return [variant, { qualified: failingProfiles.length === 0 && unexercisedFields.length === 0, perturbedFields, unexercisedFields, failingProfiles }];
}));
for (const profile of profiles) {
  const exactEvents = report.results[profile.name].exact.coverage.events;
  for (const variant of variants) {
    if (variant === 'exact') continue;
    const coverage = report.results[profile.name][variant].coverage;
    if (isDeepStrictEqual(coverage.events, exactEvents)) {
      delete coverage.events;
      coverage.eventsRef = 'exact.coverage.events';
    }
  }
}
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report,null,2)}\n`);
  console.log(`${JSON.stringify(report.summary)}\n${out}`);
} else console.log(JSON.stringify(report));
