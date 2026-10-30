import assert from 'node:assert/strict';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { synchronizePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { transitOptions } from '../shared/simulation/transit.ts';

// Transit route selection's presentation (#692, 12): a gladiator at a station sees where it may go ringed on the
// minimap, and a click on a ring that isn't the default takes it there, without a page error. The gladiator is
// placed at a station on the server.
const { server, base, browser } = await serveWithBrowser({ profileSummary: false, content: () => contentById('content-10'),
  replayDir: path.resolve('test-results/transit-replays') });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/?seed=4217`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  await page.locator('#lobby-choice').getByRole('button', { name: 'Gladiator', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().me?.role === 'gladiator');
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const game = server.rooms.get(room).game, me = game.players.find(p => !p.bot);
  const from = game.map.stations.find(st => st.x > 1500);
  Object.assign(me, { x: from.x, y: from.y, railCd: 0 }); synchronizePhysics(game);
  await page.waitForFunction(({ x, y }) => Math.hypot(window.arenaDebug().me.x - x, window.arenaDebug().me.y - y) < 40, from, { timeout: 5000 });
  const { ahead, next } = transitOptions(game, me), to = ahead.filter(st => st !== next).at(-1);
  assert.ok(to, 'a station other than the default');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve('test-results/transit.png') });
  const box = await page.locator('#minimap').boundingBox();
  await page.mouse.click(box.x + to.x / game.map.width * box.width, box.y + to.y / game.map.height * box.height);
  await page.waitForFunction(({ x, y }) => Math.hypot(window.arenaDebug().me.x - x, window.arenaDebug().me.y - y) < 120, to, { timeout: 5000 });
  assert.equal(me.railCd > 0, true, 'the transit spent the cooldown');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true }));
} finally {
  await browser.close(); await server.close();
}
