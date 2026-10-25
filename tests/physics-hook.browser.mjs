import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serveWithBrowser } from './helpers/browser.js';

// Node and Chrome run the same opt-in authoritative simulation. Chrome also
// consumes authorized frames through the engine-free production playback buffer.
async function scenario() {
  const shared = typeof window === 'undefined' ? '../shared' : '/shared';
  const { createPhysicsGame, disposePhysics, setInput, step, snapshot, playerView } = await import(`${shared}/simulation.ts`);
  const { contentById } = await import(`${shared}/simulation/content.ts`);
  const map = { seed: 446, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 250, y: 400 }], hunterSpawns: [{ x: 150, y: 400 }] };
  const content = structuredClone(contentById('content-physics-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] };
  const game = await createPhysicsGame(446, map, content);
  try {
    game.players.forEach(p => { p.bot = false; });
    const trace = [], views = [], states = [];
    const capture = () => {
      const frame = snapshot(game), view = playerView(game, frame, 'c0');
      states.push(frame);
      views.push(view);
      trace.push({ tick: frame.tick, flight: frame.hookFlights, projected: view.hookFlights,
        tethers: frame.tethers, privatePhases: frame.physics.hooks?.map(h => h.phase) });
    };
    setInput(game, 'g0', { seq: 1, skill: true, aim: 0 }); step(game); capture();
    step(game); capture();
    step(game); capture();
    setInput(game, 'g0', { seq: 4, skill: true }); step(game); capture();
    return { trace, views, states };
  } finally { disposePhysics(game); }
}

const { trace, views, states } = await scenario();
const { server, base, browser } = await serveWithBrowser({ profileSummary: false,
  replayDir: 'test-results/physics-p6-replays', devTools: 'all' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.route('**/test-constrainautor.mjs', async route => route.fulfill({ contentType: 'text/javascript',
    body: await readFile('node_modules/@kninnug/constrainautor/lib/Constrainautor.min.mjs', 'utf8') }));
  await page.route('**/', async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('"sat":',
      '"clipper-lib":"data:text/javascript,export default window.ClipperLib",' +
      '"delaunator":"data:text/javascript,export default window.Delaunator",' +
      '"@kninnug/constrainautor":"/test-constrainautor.mjs",' +
      '"sat":');
    await route.fulfill({ response, body: html });
  });
  await page.goto(base);
  await page.addScriptTag({ content: await readFile('node_modules/clipper-lib/clipper.js', 'utf8') });
  await page.addScriptTag({ content: await readFile('node_modules/delaunator/delaunator.min.js', 'utf8') });
  const browserTrace = await page.evaluate(scenario).catch(error => { throw new Error(`${error.message}\n${errors.join('\n')}`); });
  assert.deepEqual(browserTrace, { trace, views, states }, 'Node and Chrome produce identical full authoritative and projected frames');
  const chrome = await page.evaluate(async frames => {
    const { createSnapshotBuffer } = await import('/snapshot-buffer.js');
    return frames.map(frame => {
      const playback = createSnapshotBuffer({ hz: 20, delayTicks: 0, clock: () => 0 });
      playback.push(frame);
      const shown = playback.frame();
      return { flight: shown.hookFlights, tethers: shown.tethers };
    });
  }, views);
  const rendered = await page.evaluate(async frame => {
    const { drawHookFlight } = await import('/arena-scene.js');
    const commands = [];
    const g = Object.fromEntries(['lineStyle', 'lineBetween', 'fillStyle', 'fillCircle'].map(name =>
      [name, (...args) => { commands.push([name, ...args]); }]));
    const flight = frame.hookFlights[0], caster = frame.bodies.find(body => body.id === flight.a);
    drawHookFlight(g, caster, flight);
    return commands;
  }, views[0]);
  const caster = views[0].bodies.find(body => body.id === views[0].hookFlights[0].a);
  const tip = views[0].hookFlights[0];
  assert.deepEqual(rendered, [
    ['lineStyle', 3, 0xd6dfbd, 0.85], ['lineBetween', caster.x, caster.y, tip.x, tip.y],
    ['fillStyle', 0xe9f5d4, 0.95], ['fillCircle', tip.x, tip.y, 4],
  ], 'production scene draw path uses authorized caster and tip coordinates');
  assert.equal(trace[0].privatePhases[0], 'flying');
  assert.equal(trace[0].flight.length, 1);
  assert.deepEqual(chrome[0].flight, trace[0].projected);
  assert.equal(trace[1].privatePhases[0], 'pending');
  assert.deepEqual(chrome[1].flight, []);
  assert.equal(trace[2].privatePhases[0], 'pulling');
  assert.equal(trace[2].tethers.length, 1);
  assert.deepEqual(chrome[2].tethers, trace[2].tethers);
  assert.deepEqual(trace[3].privatePhases, []);
  assert.deepEqual(chrome[3].tethers, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), checks: [
    'Node/Chrome complete state equality', 'Chrome authorized flight playback', 'renderer coordinates', 'pending hit and next-tick tether', 'cancel removal' ] }));
  await page.close();
} finally { await browser.close(); await server.close(); }
