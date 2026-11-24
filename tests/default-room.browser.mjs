import assert from 'node:assert/strict';
import path from 'node:path';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { PHYSICS_VERSION } from '../shared/simulation.ts';
import { CONTENT_ID } from '../shared/simulation/content.ts';

// The shipped default (#523) is physics content, so a room made with no options is the room a player gets. This is its
// core client flow end to end: lobby, start, walking, and dropping an item, which a real map's item bodies once made
// impossible. browser.mjs is the long regression; the physics-* scripts cover the rest.
const { server, base, browser } = await serveWithBrowser({ profileSummary: false, roomThreads: false, replayDir: path.resolve('test-results/default-room-replays') });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectBrowserErrors(page, errors, { consoleErrors: true });
  await page.goto(`${base}/?seed=4217`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const live = await page.evaluate(() => window.arenaDebug());
  assert.equal(live.content, CONTENT_ID, 'a room with no options runs the shipped default');
  assert.equal(live.version, PHYSICS_VERSION, 'on the physics rules');
  const match = server.rooms.get(room).match;
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
  const frame = match.snapshot(), dropped = frame.items.find(item => item.droppedBy === me);
  assert.ok(dropped, 'the dropped weapon is on the ground');
  assert.ok(frame.bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === dropped.id), 'and has a physics body');
  assert.deepEqual(errors, []);
  console.log('Default physics browser checks passed');
  await page.close();
} finally { await browser.close(); await server.close(); }
