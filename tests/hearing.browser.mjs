import assert from 'node:assert/strict';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { contentById } from '../shared/simulation/content.ts';
import { hearShot } from '../shared/simulation/hearing.ts';

// Heard gunfire's presentation (#684, 29.4): a cue reaches the player's own frame and is drawn, as a ring
// on screen and an edge arrow off it, and on the minimap, without a page error. Shots are arranged on the server.
const { server, base, browser } = await serveWithBrowser({ profileSummary: false, content: () => contentById('content-8'),
  replayDir: path.resolve('test-results/hearing-replays') });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/?seed=4217`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const game = server.rooms.get(room).game, me = game.players.find(p => !p.bot);
  // One shot from the player's own spot, drawn as a ring, and one far to the side, drawn as an edge arrow.
  const shooter = game.players.find(p => p.bot && p.role === 'contestant');
  for (const dx of [0, 3000]) hearShot(game, { ...shooter, id: 'arranged', x: me.x + dx, y: me.y }, 'scattergun');
  await page.waitForFunction(() => (window.arenaDebug().me.heard?.length ?? 0) === 2, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve('test-results/hearing.png') });
  // The cue fades: four seconds later the player's frame carries none.
  await page.waitForFunction(() => window.arenaDebug().me.heard === undefined, null, { timeout: 8000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true }));
} finally {
  await browser.close(); await server.close();
}
