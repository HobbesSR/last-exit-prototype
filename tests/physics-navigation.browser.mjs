import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { PHYSICS_VERSION, createGame, disposePhysics, stateOf, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';

const map = { seed: 448, width: 1200, height: 800,
  playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 12]] })) },
  buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [{ id: 'charger', x: 800, y: 400 }], sensors: [],
  items: [{ id: 'objective', kind: 'cell', charge: 0, x: 650, y: 400 }],
  traps: [],
  physicsProps: [{ id: 'crate', profile: 'crate', x: 350, y: 400, angle: Math.PI / 4 }],
  entry: { x: 100, y: 400 }, exit: { x: 1050, y: 400 }, spawns: [{ x: 150, y: 400 }] };
const content = structuredClone(contentById('content-6'));
content.roster = { contestants: ['Navigator'], gladiators: [] };
content.discovery = false;
const game = await createGame(448, structuredClone(map), content);
const expected = [];
try {
  for (let tick = 0; tick < 360 && game.phase === 'live'; tick++) {
    step(game);
    const state = stateOf(game), p = state.players[0];
    expected.push([state.tick, p.x, p.y, p.status, state.slots]);
  }
  assert.equal(expected.at(-1)[3], 'escaped', JSON.stringify(expected.at(-1)));
  assert.ok(expected.some(frame => Math.abs(frame[2] - 400) > 20), 'autonomous bot detoured around the crate');
} finally { disposePhysics(game); }
const { server, base, browser } = await serveWithBrowser({ replayDir: 'test-results/physics-navigation-replays', devTools: 'all' });
try {
  const page = await browser.newPage(), errors = [];
  collectBrowserErrors(page, errors);
  await page.route('**/test-constrainautor.mjs', async route => route.fulfill({ contentType: 'text/javascript',
    body: await readFile('node_modules/@kninnug/constrainautor/lib/Constrainautor.min.mjs', 'utf8') }));
  await page.route('**/', async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('"sat":',
      '"clipper-lib":"data:text/javascript,export default window.ClipperLib",' +
      '"delaunator":"data:text/javascript,export default window.Delaunator",' +
      '"@kninnug/constrainautor":"/test-constrainautor.mjs","sat":');
    await route.fulfill({ response, body: html });
  });
  await page.goto(base);
  await page.addScriptTag({ content: await readFile('node_modules/clipper-lib/clipper.js', 'utf8') });
  await page.addScriptTag({ content: await readFile('node_modules/delaunator/delaunator.min.js', 'utf8') });
  const actual = await page.evaluate(async ({ map, content }) => {
    const { createGame, disposePhysics, step, stateOf } = await import('/shared/simulation.ts');
    const game = await createGame(448, map, content), trace = [];
    try {
      for (let tick = 0; tick < 360 && game.phase === 'live'; tick++) {
        step(game);
        const state = stateOf(game), p = state.players[0];
        trace.push([state.tick, p.x, p.y, p.status, state.slots]);
      }
      return { version: game.version, trace };
    } finally { disposePhysics(game); }
  }, { map, content });
  assert.equal(actual.version, PHYSICS_VERSION);
  assert.deepEqual(actual.trace, expected);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), ticks: expected.length,
    checks: ['autonomous body detour', 'pickup/charge/extraction', 'Node/Chrome exact trace'] }));
} finally { await browser.close(); await server.close(); }
