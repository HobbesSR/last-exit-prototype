// Synthetic fogged playback workload for the arena scene's synchronous update CPU.
// Run alone: node tools/physics/visibility-report.mjs [output.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serveWithBrowser } from '../../tests/helpers/browser.js';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const WARMUP = 30, SAMPLES = 120;
const output = process.argv[2] ?? 'test-results/physics-485-visibility.json';
const lock = await acquireMachineLock('bench');
let server, browser, base;
try {
  ({ server, browser, base } = await serveWithBrowser({ profileSummary: false }));
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/physics-visibility-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<html><body style="margin:0"><script type="importmap">{"imports":{"sat":"/sat-browser.js"}}</script><script src="/vendor/sat/SAT.js"></script><script src="/vendor/phaser/phaser.min.js"></script></body></html>' }));
  await page.goto(`${base}/physics-visibility-fixture`);
  await page.evaluate(async () => {
    const { makeArenaScene } = await import('/arena-scene.js');
    const map = { seed: 1, width: 5000, height: 3000, modules: [], hazards: [], gaps: [], stations: [], sensors: [], gates: [], routes: [], buildings: [],
      obstacles: [{ id: 'wall', kind: 'wall', x: 700, y: 200, w: 10, h: 400 }] };
    const player = { id: 'self', name: 'Viewer', role: 'contestant', x: 500, y: 400, heading: 0, status: 'active', hp: 100, maxHp: 100 };
    const state = { tick: 1, physicsProfile: 'synthetic-visibility', players: [player], gates: [], items: [], traps: [], projectiles: [], effects: [], bodies: [], tethers: [] };
    const api = { map: () => map, state: () => state, self: () => player, playerId: () => player.id, directed: () => false,
      follow: () => null, replay: () => true, onFrame() {}, onReady(scene) { window.scene = scene; }, onFire() {}, frameAlpha: () => 0, aim: () => 0 };
    window.fixture = { map, player, state };
    window.game = new Phaser.Game({ type: Phaser.WEBGL, width: 900, height: 700, audio: { noAudio: true }, scene: makeArenaScene(api) });
  });
  await page.waitForFunction(() => window.scene?.ready && window.scene.dynamic);
  const result = await page.evaluate(({ warmup, samples }) => {
    const { state } = window.fixture, scene = window.scene;
    // Phaser may continue rendering, but it must not update the scene between timed calls.
    scene.scene.pause();
    const prop = (id, x, y) => ({ id, kind: 'prop', x, y, angle: 0, vx: 0, vy: 0, omega: 0,
      sleeping: false, generation: 1, shape: { kind: 'circle', radius: 25 } });
    const cohorts = {
      visible: Array.from({ length: 32 }, (_, i) => prop(`visible-${i}`, 540 + (i % 4) * 25, 260 + Math.floor(i / 4) * 35)),
      edge: Array.from({ length: 32 }, (_, i) => prop(`edge-${i}`, 715, 260 + i * 9)),
      shadow: Array.from({ length: 64 }, (_, i) => prop(`shadow-${i}`, 770 + (i % 4) * 8, 250 + Math.floor(i / 4) * 18)),
      offscreen: Array.from({ length: 64 }, (_, i) => prop(`offscreen-${i}`, 2000 + (i % 4) * 25, 250 + Math.floor(i / 4) * 18)),
    };
    const cases = [
      ['baseline', []],
      ['mixed', [...cohorts.visible, ...cohorts.edge, ...cohorts.shadow.slice(0, 32), ...cohorts.offscreen.slice(0, 32)]],
      ['shadowOffscreen', [...cohorts.shadow, ...cohorts.offscreen]],
    ];
    const measured = [];
    for (const [name, bodies] of cases) {
      state.bodies = bodies;
      for (let i = 0; i < warmup; i++) scene.update(performance.now(), 16);
      const sightEdges = scene.sight?.points?.length ?? 0;
      const coords = new Map(bodies.map(body => [`${body.x},${body.y}`, body.id]));
      const drawn = new Set();
      const graphics = scene.dynamic, original = graphics.fillCircle;
      graphics.fillCircle = function(x, y, ...rest) {
        const id = coords.get(`${x},${y}`);
        if (id) drawn.add(id);
        return original.call(this, x, y, ...rest);
      };
      scene.update(performance.now(), 16);
      graphics.fillCircle = original;
      const times = [];
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        scene.update(start, 16);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const drawnByCohort = Object.fromEntries(Object.entries(cohorts).map(([cohort, entries]) =>
        [cohort, entries.filter(body => drawn.has(body.id)).length]));
      measured.push({ name, bodies: bodies.length, sightEdges, drawnByCohort,
        updateCpuMs: { mean: times.reduce((sum, time) => sum + time, 0) / samples, p95: times[Math.ceil(samples * .95) - 1], max: times.at(-1) } });
    }
    return { measured, browser: navigator.userAgent, rendererType: window.game.renderer.type,
      viewport: { width: scene.cameras.main.width, height: scene.cameras.main.height, zoom: scene.cameras.main.zoom },
      engineLoaded: performance.getEntriesByType('resource').some(entry => /rapier|physics-world/i.test(entry.name)) };
  }, { warmup: WARMUP, samples: SAMPLES });
  assert.deepEqual(errors, [], 'browser page errors');
  assert.equal(result.engineLoaded, false, 'playback must not load the physics engine');
  const [baseline, mixed, hidden] = result.measured;
  assert.deepEqual(result.measured.map(entry => entry.bodies), [0, 128, 128]);
  assert.ok(result.measured.every(entry => entry.sightEdges > 0), 'all cases must compute fogged sight');
  assert.ok(mixed.drawnByCohort.visible > 0 && mixed.drawnByCohort.edge > 0, 'visible and partly visible props must draw');
  assert.equal(mixed.drawnByCohort.shadow, 0, 'fully shadowed props must not draw');
  assert.equal(mixed.drawnByCohort.offscreen, 0, 'offscreen props must not draw');
  assert.equal(hidden.drawnByCohort.shadow + hidden.drawnByCohort.offscreen, 0, 'hidden case must draw no props');
  assert.equal(baseline.drawnByCohort.visible + baseline.drawnByCohort.edge + baseline.drawnByCohort.shadow + baseline.drawnByCohort.offscreen, 0);
  const files = {};
  for (const file of ['tools/physics/visibility-report.mjs', 'public/arena-scene.js', 'shared/view.ts', 'shared/shape.ts', 'shared/physics/presentation-geometry.ts']) {
    files[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const report = { date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, browser: result.browser, rendererType: result.rendererType, files,
    workload: { warmup: WARMUP, samples: SAMPLES, viewport: result.viewport, actor: { x: 500, y: 400 }, wall: { x: 700, y: 200, w: 10, h: 400 },
      cases: ['no props', '32 visible + 32 edge + 32 shadow + 32 offscreen', '64 shadow + 64 offscreen'] },
    measurements: result.measured,
    limitations: ['Synthetic static playback projection; excludes physics simulation, transport and real match scheduling.',
      'Synchronous scene.update CPU only; excludes Phaser render, GPU time and frame pacing.',
      'Graphics method hooks count submitted prop circles in one untimed update, not pixels.',
      'No before/after speedup is inferred from these case timings.'] };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await page.close();
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  lock.release();
}
