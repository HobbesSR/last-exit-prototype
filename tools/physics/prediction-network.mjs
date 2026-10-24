// Deterministic, synthetic WebSocket scheduling witness for P4. No sockets or
// browser scheduler are involved: messages are ordered and reliable per stream.
// Node runs both the real authoritative physics game and production predictor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createPhysicsGame, disposePhysics, playerView, setInput, snapshot, step } from '../../shared/simulation.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { resetInput } from '../../shared/simulation/input.ts';
import { createPhysicsPrediction, PREDICTION_LIMITS } from '../../public/physics-prediction.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

await acquireMachineLock('bench');
const TICK_MS = 50;
const LAST_TICK = 85;
const percentiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
};
const round = number => Math.round(number * 1000) / 1000;
const stats = values => Object.fromEntries(Object.entries(percentiles(values.filter(Number.isFinite))).map(([key, value]) => [key, round(value)]));
function fixture() {
  const map = { seed: 441, width: 800, height: 600,
    playableArea: { cellSize: 100, rows: Array.from({ length: 6 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [{ id: 'wall', x: 600, y: 100, w: 16, h: 400 }],
    gates: [{ id: 'door', x: 420, y: 300, w: 24, h: 100, open: true, kind: 'gate' }],
    hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 300 }, exit: { x: 760, y: 300 },
    spawns: [{ x: 150, y: 300 }, { x: 700, y: 200 }], hunterSpawns: [{ x: 700, y: 500 }] };
  const content = structuredClone(contentById('content-physics-2'));
  content.roster = { contestants: ['Self', 'Other'], gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}
const profiles = [
  { name: 'rtt-0', rtt: 0 }, { name: 'rtt-50', rtt: 50 },
  { name: 'rtt-100', rtt: 100 }, { name: 'rtt-200', rtt: 200 },
  { name: 'jitter-and-stall', rtt: 100, jitter: true, stall: true },
  { name: 'application-frame-gaps', rtt: 50, frameGaps: true },
  { name: 'background-resume', rtt: 100, background: true },
  { name: 'reconnect', rtt: 100, reconnect: true },
  { name: 'hidden-contact', rtt: 50, hidden: true },
  { name: 'stale-known-door', rtt: 50, staleDoor: true },
  { name: 'queue-trim-and-repeats', rtt: 100, burst: true, stall: true },
];

async function run(profile) {
  const { map, content } = fixture();
  if (profile.hidden) map.spawns[1] = { x: 174, y: 300 };
  const game = await createPhysicsGame(441, map, content);
  for (const player of game.players) player.bot = false;
  let now = 0, predictor = await createPhysicsPrediction(game.map, 'c0', { clock: () => now });
  const events = [], errors = [], correctionErrors = [], correctionCpu = [], inputCpu = [];
  const reasons = {}, ackSessions = [[]], depths = [], repeats = [];
  let order = 0, seq = 0, inputBytes = 0, frameBytes = 0, correctionCount = 0, maxReplay = 0, predictedTicks = 0;
  let predictorResets = 0, serverQueueResets = 0, trimmedInputs = 0;
  let doorAuthorityMaxX = -Infinity, doorPredictionMaxX = -Infinity, doorMaxDivergence = 0;
  let lastUpAt = -Infinity, lastDownAt = -Infinity, connectionEpoch = 0, lastCorrectionTick = -Infinity;
  const enqueue = (at, priority, run) => events.push({ at, priority, order: order++, run });
  const flight = (tick, side) => {
    const jitter = profile.jitter ? ((tick * 17 + (side === 'up' ? 3 : 11)) % 5 - 2) * 10 : 0;
    const stall = profile.stall && tick >= 23 && tick <= 31 ? 360 : 0;
    return Math.max(0, profile.rtt / 2 + jitter + stall);
  };
  const delivery = (tick, side, priority, run) => {
    const sentEpoch = connectionEpoch;
    const proposed = now + flight(tick, side);
    const at = side === 'up' ? lastUpAt = Math.max(proposed, lastUpAt + 0.001)
      : lastDownAt = Math.max(proposed, lastDownAt + 0.001);
    enqueue(at, priority, () => { if (sentEpoch === connectionEpoch) run(); });
  };
  const input = (tick, burst = false) => {
    const fields = { seq: seq++, x: tick < 50 ? 1 : tick < 60 ? -1 : 0, y: 0, sneak: false };
    const bytes = Buffer.byteLength(JSON.stringify(fields)); inputBytes += bytes;
    const begin = process.hrtime.bigint(); predictor.input(fields);
    inputCpu.push(Number(process.hrtime.bigint() - begin) / 1e6);
    const sent = structuredClone(fields);
    delivery(tick, 'up', 1, () => {
      const queueBefore = game.players[0].inputQueue?.length ?? 0;
      const accepted = setInput(game, 'c0', sent);
      if (accepted && queueBefore === 4) trimmedInputs++;
      if (burst) depths.push(game.players[0].inputQueue?.length ?? 0);
    });
  };
  const deliver = wire => {
    if (!predictor || wire.tick <= lastCorrectionTick) return;
    const begin = process.hrtime.bigint(); predictor.correct(wire);
    correctionCpu.push(Number(process.hrtime.bigint() - begin) / 1e6);
    correctionCount++;
    const state = predictor.stats(); maxReplay = Math.max(maxReplay, state.replayed);
    if (state.reason) reasons[state.reason] = (reasons[state.reason] ?? 0) + 1;
    if (typeof state.error === 'number') correctionErrors.push(state.error);
    ackSessions.at(-1).push(wire.players.find(p => p.id === 'c0').lastSeq);
    lastCorrectionTick = wire.tick;
  };
  try {
    deliver(playerView(game, snapshot(game), 'c0'));
    if (profile.background) {
      enqueue(23 * TICK_MS, -1, () => { predictor.dispose(); predictor = null; });
      enqueue(39 * TICK_MS, -1, async () => {
        predictor = await createPhysicsPrediction(game.map, 'c0', { clock: () => now });
        predictorResets++;
        lastCorrectionTick = -Infinity;
        deliver(playerView(game, snapshot(game), 'c0'));
      });
    }
    if (profile.reconnect) {
      enqueue(28 * TICK_MS, -1, () => {
        predictor.dispose(); predictor = null; connectionEpoch++;
      });
      enqueue(36 * TICK_MS, -1, async () => {
        resetInput(game.players.find(player => player.id === 'c0'));
        serverQueueResets++;
        seq = 0; connectionEpoch++; lastUpAt = lastDownAt = -Infinity;
        ackSessions.push([]);
        predictor = await createPhysicsPrediction(game.map, 'c0', { clock: () => now });
        predictorResets++;
        lastCorrectionTick = -Infinity;
        deliver(playerView(game, snapshot(game), 'c0'));
      });
    }
    for (let tick = 1; tick <= LAST_TICK; tick++) {
      const at = tick * TICK_MS;
      enqueue(at, 0, () => {
        if (profile.background && tick >= 23 && tick <= 38) return;
        if (profile.reconnect && tick >= 28 && tick <= 35) return;
        if (profile.burst && tick === 20) for (let i = 0; i < 10; i++) input(tick, true);
        else input(tick);
      });
      enqueue(at, 2, () => {
        if (profile.staleDoor && tick === 5) game.map.gates[0].open = false;
        step(game);
        repeats.push(game.players[0].inputStalled ?? 0);
        if ((profile.frameGaps && tick >= 24 && tick <= 29) ||
          (profile.reconnect && tick >= 28 && tick <= 35)) return;
        const frame = playerView(game, snapshot(game), 'c0');
        // Emulate a deliberately withheld dynamic proxy. This is a privacy
        // stress case, not a claim playerView would omit a nearby contestant.
        if (profile.hidden) frame.bodies = frame.bodies.filter(body => body.actorId !== 'c1');
        // Emulate stale client memory while authority enforces the closed gate.
        if (profile.staleDoor && tick >= 5 && tick <= 39)
          frame.gates = frame.gates.map(gate => gate.id === 'door' ? { ...gate, open: true } : gate);
        frameBytes += Buffer.byteLength(JSON.stringify(frame));
        delivery(tick, 'down', 3, () => deliver(frame));
      });
      enqueue(at + TICK_MS - 1, 4, () => {
        const pose = predictor?.value();
        if (pose) {
          const authoritative = game.players.find(p => p.id === 'c0');
          errors.push(Math.hypot(pose.x - authoritative.x, pose.y - authoritative.y));
          if (profile.staleDoor && tick >= 5 && tick <= 39) {
            doorAuthorityMaxX = Math.max(doorAuthorityMaxX, authoritative.x);
            doorPredictionMaxX = Math.max(doorPredictionMaxX, pose.x);
            doorMaxDivergence = Math.max(doorMaxDivergence, pose.x - authoritative.x);
          }
          if (predictor.stats().reason === null) predictedTicks++;
        } else errors.push(null);
      });
    }
    while (events.length) {
      events.sort((a, b) => a.at - b.at || a.priority - b.priority || a.order - b.order);
      const event = events.shift(); now = event.at; await event.run();
    }
    assert.ok(maxReplay <= PREDICTION_LIMITS.replay, `${profile.name}: replay cap`);
    assert.ok(ackSessions.every(ack => ack.every((value, index) => index === 0 || value >= ack[index - 1])),
      `${profile.name}: ordered acknowledgement within session`);
    if (profile.frameGaps) assert.ok(reasons['frame-gap'] > 0, 'application frame gap cut occurred');
    if (profile.burst) {
      assert.equal(Math.max(...depths), 4, 'server queue filled to cap');
      assert.ok(trimmedInputs > 0, 'server queue trimmed oldest input');
      assert.ok(repeats.some(value => value > 0), 'authority repeated during starvation');
    }
    if (profile.hidden || profile.staleDoor)
      assert.ok(correctionErrors.some(value => value > 0.01), `${profile.name}: measurable correction disagreement`);
    if (profile.staleDoor) {
      assert.ok(doorAuthorityMaxX > 380 && doorAuthorityMaxX < 420, 'authority reaches and stops at the closed gate');
      assert.ok(doorMaxDivergence > 1, 'stale open memory lets prediction pass authority at gate');
    }
    if (profile.background) assert.equal(predictorResets, 1, 'background resume recreated predictor');
    if (profile.reconnect) assert.deepEqual([predictorResets, serverQueueResets], [1, 1], 'reconnect resets both sides');
    const neutralInputTick = 60, settleStart = neutralInputTick - 1, threshold = 1;
    let settleTicks = null;
    for (let i = settleStart; i <= errors.length - 3; i++)
      if (errors.slice(i, i + 3).every(error => error !== null && error <= threshold)) { settleTicks = i - settleStart; break; }
    return { name: profile.name, rttMs: profile.rtt, samples: errors.filter(Number.isFinite).length,
      errorUnits: stats(errors.filter(Number.isFinite)), preCorrectionErrorUnits: stats(correctionErrors),
      neutralInputTick, settleTicksAfterNeutral: settleTicks, settleThresholdUnits: threshold,
      corrections: correctionCount, predictedTicks, cutsByReason: reasons, maxReplay,
      witnessCounts: { predictorResets, serverQueueResets, trimmedInputs, authorityRepeatTicks: repeats.filter(value => value > 0).length },
      ...(profile.staleDoor ? { door: { authorityMaxX: round(doorAuthorityMaxX), predictionMaxX: round(doorPredictionMaxX),
        maxPredictedLead: round(doorMaxDivergence) } } : {}),
      bytes: { inputs: inputBytes, frames: frameBytes, total: inputBytes + frameBytes },
      cpuMs: { input: stats(inputCpu), correct: stats(correctionCpu) },
      authority: { maxQueueDepthObserved: Math.max(0, ...depths), maxRepeatTicks: Math.max(0, ...repeats),
        finalAckBySession: ackSessions.map(ack => ack.at(-1)) } };
  } finally { predictor?.dispose(); disposePhysics(game); }
}

const files = ['tools/physics/prediction-network.mjs', 'tests/physics-prediction.browser.mjs',
  'public/physics-prediction.js', 'public/physics-prediction-limits.js',
  'shared/physics/world.ts', 'shared/physics/motion-limits.ts', 'shared/simulation/phased.ts',
  'shared/simulation/visibility.ts', 'shared/simulation/input.ts', 'shared/simulation/actor-physics.ts',
  'shared/simulation/content.ts', 'package-lock.json',
  'node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm'];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const packageVersion = JSON.parse(readFileSync('node_modules/@dimforge/rapier2d-compat/package.json', 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirtySources = execFileSync('git', ['status', '--short', '--', ...files.filter(file => !file.startsWith('node_modules/'))], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const results = [];
for (const profile of profiles) results.push(await run(profile));
const report = { witness: 'P4 deterministic scheduled-delivery lab', date: new Date().toISOString(),
  commit, dirtySources, hashes,
  runtime: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch,
    cpu: os.cpus()[0]?.model, rapierPackage: packageVersion },
  settings: { seed: 441, map: 'authored 800x600 full mask, wall and gate; two contestants plus gladiator',
    physicsContent: 'content-physics-2', actorPhysics: contentById('content-physics-2').actorPhysics,
    profiles, sampling: 'once per tick at t+49 ms after scheduled events',
    clock: 'synthetic millisecond event time', ordering: 'reliable FIFO per connection direction' },
  tickMs: TICK_MS, ticks: LAST_TICK,
  limitations: ['Synthetic ordered/reliable message scheduling; no real socket, browser event loop, packet loss or bandwidth congestion',
    'Hidden proxy withholding and stale gate memory are injected into projections for stress; not emitted by playerView in these nearby scenarios',
    'CPU numbers are Node wall-clock samples for predictor calls and require uncontended repeat runs for regression claims',
    'Error samples compare current predictor pose with current authority each tick, including legitimate in-flight delay'],
  results };
if (process.argv.includes('--write-report')) writeFileSync('docs/reports/physics-441-network.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
