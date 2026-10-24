import assert from 'node:assert/strict';
import { serveWithBrowser } from './helpers/browser.js';
import { contentById } from '../shared/simulation/content.ts';
import { createPhysicsMatch } from '../server/match.js';

// Delivery is scheduled here, not sent through a real WebSocket. Chrome loads
// the production prediction module and its production Rapier WASM bootstrap.
const content = structuredClone(contentById('content-physics-2'));
content.roster = { contestants: ['Self', 'Other'], gladiators: [] };
const map = { seed: 441, width: 1200, height: 800,
  playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 12]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  entry: { x: 100, y: 400 }, exit: { x: 1100, y: 400 },
  spawns: [{ x: 300, y: 400 }, { x: 900, y: 400 }], hunterSpawns: [] };
const { server, base, browser } = await serveWithBrowser({ profileSummary: false,
  replayDir: 'test-results/physics-p4-replays', content: () => structuredClone(content),
  matchFactory: createPhysicsMatch, generateMap: () => structuredClone(map) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { createPhysicsPrediction, PREDICTION_LIMITS } = await import('/physics-prediction.js');
    const map = { width: 600, height: 400, obstacles: [], gates: [],
      playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) } };
    const own = (x = 100, vx = 0) => ({ id: 'actor:self', actorId: 'self', kind: 'actor',
      shape: { kind: 'circle', radius: 9.6 }, x, y: 200, vx, vy: 0, angle: 0, generation: 1 });
    const frame = (tick, lastSeq = -1, x = 100, vx = 0) => ({ tick, physicsProfile: 'P2',
      predictionMotor: { acceleration: 3600, braking: 3600, maxSpeed: 614.4 },
      players: [{ id: 'self', role: 'contestant', x, y: 200, status: 'active', boost: 0, stun: 0, lastSeq, hp: 100 }],
      bodies: [own(x, vx)], tethers: [], gates: [] });
    let clock = 0;
    const predictor = await createPhysicsPrediction(map, 'self', { clock: () => clock });
    try {
      predictor.correct(frame(1));
      const afterInput = { ...predictor.input({ seq: 0, x: 1, y: 0, attack: true }) };
      clock = 75; // A 75 ms synthetic delivery delay.
      const beforeCorrection = { ...predictor.value() };
      predictor.correct(frame(2, -1));
      const afterReplay = { ...predictor.value() };
      const replayed = predictor.stats().replayed;
      predictor.correct(frame(3, 0, afterInput.x, afterInput.vx));
      const acknowledged = { ...predictor.value() };
      for (let seq = 1; seq <= PREDICTION_LIMITS.replay + 1; seq++)
        predictor.input({ seq, x: 1, y: 0 });
      const cap = predictor.stats();
      return { afterInput, beforeCorrection, afterReplay, replayed, acknowledged, cap,
        resources: performance.getEntriesByType('resource').map(entry => entry.name) };
    } finally { predictor.dispose(); }
  });
  assert.ok(result.afterInput.x > 100, 'real WASM motor advances own pose');
  assert.equal(result.beforeCorrection.x, result.afterInput.x);
  assert.ok(Math.abs(result.afterReplay.x - result.afterInput.x) < 0.001, 'delayed correction replays pending input once');
  assert.equal(result.replayed, 1);
  assert.ok(Math.abs(result.acknowledged.x - result.afterInput.x) < 0.001, 'acknowledged input is not replayed');
  assert.equal(result.cap.reason, 'replay-cap');
  assert.ok(result.cap.replayed <= 8);
  assert.equal(result.cap.inputs, 0);
  assert.ok(result.resources.some(name => /rapier/i.test(name)), 'Chrome loaded the Rapier bootstrap');
  assert.deepEqual(errors, []);
  await page.close();

  // This pass traverses the actual page, input controller, WebSocket, server
  // match, physics projection, predictor and presentation wiring.
  const live = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  live.on('pageerror', error => errors.push(error.message));
  live.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await live.goto(`${base}/?seed=441`);
  await live.getByRole('button', { name: 'Start match', exact: true }).click();
  await live.waitForFunction(() => window.arenaDebug?.().phase === 'live' &&
    window.arenaDebug().version === 'last-exit-0.8-physics-2' &&
    window.arenaDebug().physicsPrediction?.rebuilds > 0, null, { timeout: 15000 });
  const initial = await live.evaluate(() => window.arenaDebug());
  await live.evaluate(() => {
    window.__predictionSamples = [];
    window.__predictionSampler = setInterval(() => {
      const d = window.arenaDebug();
      if (d.predicted && d.me) window.__predictionSamples.push({ predicted: d.predicted.x, authority: d.me.x,
        actor: d.actors?.find(actor => actor.id === d.me.id)?.x });
    }, 10);
  });
  await live.keyboard.down('KeyD');
  await live.waitForTimeout(650);
  await live.keyboard.up('KeyD');
  const moved = await live.evaluate(() => {
    clearInterval(window.__predictionSampler);
    return { debug: window.arenaDebug(), samples: window.__predictionSamples };
  });
  assert.ok(moved.debug.me.x > initial.me.x + 40, 'real server consumed browser movement');
  assert.ok(moved.samples.some(sample => sample.predicted > sample.authority + 0.1),
    'own predicted pose leads the received authoritative frame');
  assert.ok(moved.debug.physicsPrediction.rebuilds > 0 && moved.debug.physicsPrediction.replayed <= 8);
  const previousId = moved.debug.me.id;
  await live.reload();
  await live.waitForFunction(id => window.arenaDebug?.().phase === 'live' &&
    window.arenaDebug().me?.id === id && window.arenaDebug().physicsPrediction?.rebuilds > 0,
  previousId, { timeout: 15000 });
  const resumed = await live.evaluate(() => window.arenaDebug());
  await live.keyboard.down('KeyD'); await live.waitForTimeout(650); await live.keyboard.up('KeyD');
  await live.waitForFunction(x => window.arenaDebug().me.x > x + 40, resumed.me.x, { timeout: 5000 });
  assert.ok((await live.evaluate(() => window.arenaDebug().physicsPrediction.replayed)) <= 8);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), scheduling: 'synthetic 75 ms delay plus live socket',
    checks: ['production predictor and Rapier WASM', 'own pose', 'delayed correction', 'replay cap',
      'live input/projection/presentation wiring', 'reload reconnect'] }));
  await live.close();
} finally { await browser.close(); await server.close(); }
