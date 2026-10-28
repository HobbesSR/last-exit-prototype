import assert from 'node:assert/strict';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';

// The shipped default (#523) is physics content, so a room made with no options is the room a player gets. This is its
// core client flow end to end: lobby, start, walking, and dropping an item, which a real map's item bodies once made
// impossible. The long legacy-mover regression in browser.mjs pins the legacy set; the physics-* scripts cover the rest.
const { server, base, browser } = await serveWithBrowser({ profileSummary: false, replayDir: path.resolve('test-results/default-physics-replays') });
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
  const live = await page.evaluate(() => window.arenaDebug());
  assert.equal(live.content, 'content-6', 'a room with no options runs the shipped default');
  assert.equal(live.version, 'last-exit-0.8-physics-8', 'on the physics rules');
  const game = server.rooms.get(room).game;
  assert.equal(server.rooms.get(room).match.hasPhysics, true, 'the server built a physics match');
  // Walking: the client predicts and the server's physics world agrees.
  const before = live.me.x;
  await page.keyboard.down('KeyD'); await page.waitForTimeout(650); await page.keyboard.up('KeyD');
  await page.waitForFunction(x => window.arenaDebug().me.x > x + 40, before, { timeout: 5000 });
  // Dropping: a real map's items must not leave the world without a body slot for the drop.
  const me = live.me.id;
  await page.keyboard.press('Digit1');
  await page.waitForFunction(() => window.arenaDebug().me.selectedSlot === 0);
  await page.waitForFunction(() => window.arenaDebug().me.inventory[0]?.kind === 'weapon');
  await page.getByRole('button', { name: 'Drop selected', exact: false }).click();
  await page.waitForFunction(() => window.arenaDebug().me.inventory[0] === null, null, { timeout: 8000 });
  const dropped = game.map.items.find(item => item.droppedBy === me);
  assert.ok(dropped, 'the dropped weapon is on the ground');
  assert.equal(physicsRuntime(game).items.has(`item:${dropped.id}`), true, 'and has a physics body');
  assert.deepEqual(errors, []);
  console.log('Default physics browser checks passed');
  await page.close();
} finally { await browser.close(); await server.close(); }
