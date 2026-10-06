// The dev view (#231) on its own: a player's tab, the dev tab it opens, and what the dev tab can do to
// the room. Separate from browser.mjs so it can be iterated on in seconds rather than minutes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-dev-view-'));
await mkdir('test-results', { recursive: true });
const server = await createArenaServer({ replayDir, profileSummary: false, devTools: 'all' });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const watch = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
};
/** Poll a server-side condition, failing with what the tab thought when it never holds. */
async function until(condition, describe, timeout = 5000) {
  for (let waited = 0; !condition(); waited += 25) {
    if (waited >= timeout) assert.fail(`${describe()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); watch(page);
  await page.goto(`${base}/?seed=4217`);
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug?.().tick > 3);
  const { room: roomId, me } = await page.evaluate(() => window.arenaDebug());
  const room = server.rooms.get(roomId), subject = me.id;

  // A player steps out to the dev view in place (#246): their socket and slot stay, input stops, and
  // the view is the undelayed directed one. Stepping back returns to their own fogged view.
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().directed && window.arenaDebug().cameraWidth >= window.arenaDebug().mapWidth);
  const stepped = await page.evaluate(() => ({ ...window.arenaDebug(), hud: document.getElementById('live-hud').hidden }));
  assert.equal(stepped.vision, null); assert.equal(stepped.hud, true);
  assert.ok(room.match.roster().some(p => p.id === subject), 'stepping out keeps the slot');
  const seqOf = () => room.match.snapshot().players.find(p => p.id === subject).lastSeq;
  await page.waitForTimeout(300); const parked = seqOf();
  await page.keyboard.down('KeyD'); await page.waitForTimeout(400); await page.keyboard.up('KeyD');
  assert.equal(seqOf(), parked, 'no input reaches the player while in the dev view');
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && !window.arenaDebug().directed && window.arenaDebug().vision);
  await until(() => seqOf() > parked + 3, () => `input resumes after stepping back: ${seqOf()} vs ${parked}`);
  assert.equal(room.spectators, 0, 'the dev socket closed');

  // A standalone dev tab: undelayed and unfogged, on the whole arena.
  const dev = await browser.newPage(); watch(dev);
  await dev.setViewportSize({ width: 1440, height: 1000 });
  await dev.goto(`${base}/?room=${roomId}&dev`);
  await dev.waitForFunction(() => window.arenaDebug?.().dev && window.arenaDebug().tick > 0 && window.arenaDebug().camera, null, { timeout: 15000 });
  const start = await dev.evaluate(() => ({ ...window.arenaDebug(), status: document.getElementById('connection-text').textContent }));
  assert.equal(start.status, 'DEV VIEW'); assert.equal(start.me, undefined, 'the dev view holds no slot');
  assert.ok(room.match.tick - start.tick < 20, `the dev view is not delayed: ${start.tick} vs ${room.match.tick}`);
  assert.equal(start.vision, null); assert.ok(start.cameraWidth >= start.mapWidth, 'the dev view opens on the whole arena');

  // A free camera: the wheel zooms about the pointer and held keys pan.
  await dev.mouse.move(720, 500); await dev.mouse.wheel(0, -1500);
  await dev.waitForFunction(zoom => window.arenaDebug().camera.zoom > zoom * 2, start.camera.zoom);
  const zoomed = await dev.evaluate(() => window.arenaDebug().camera);
  await dev.keyboard.down('KeyD'); await dev.waitForTimeout(400); await dev.keyboard.up('KeyD');
  assert.ok((await dev.evaluate(() => window.arenaDebug().camera.x)) > zoomed.x + 50, 'held keys pan the free camera');

  // Following shows the player in their own sight until fog is toggled off; Esc lets go.
  await dev.locator('#dev-focus').selectOption(subject);
  await dev.waitForFunction(id => window.arenaDebug().follow === id && window.arenaDebug().viewer === id && window.arenaDebug().vision, subject);
  const followed = await dev.evaluate(id => ({ debug: window.arenaDebug(), subject: window.arenaDebug().actors.find(a => a.id === id) }), subject);
  assert.ok(Math.abs(followed.debug.camera.x + followed.debug.cameraWidth / 2 - followed.subject.x) < 60, 'following centres on the subject');
  await dev.keyboard.press('KeyV');
  await dev.waitForFunction(() => window.arenaDebug().viewer === null && window.arenaDebug().vision === null && window.arenaDebug().follow);
  await dev.keyboard.press('Escape');
  await dev.waitForFunction(() => window.arenaDebug().follow === null);
  await dev.screenshot({ path: 'test-results/dev-view.png' });

  // Pausing (#245) stops the room for everyone in it, and Space resumes it.
  await dev.getByRole('button', { name: 'Pause match', exact: true }).click();
  const tabs = async () => JSON.stringify({ dev: await dev.evaluate(() => window.arenaDebug().paused), player: await page.evaluate(() => window.arenaDebug().paused) });
  await until(() => room.pausedAt != null, () => 'the pause reached the server');
  const pausedAt = room.match.tick;
  await page.waitForFunction(() => window.arenaDebug().paused && !document.getElementById('paused-banner').hidden, null, { timeout: 5000 })
    .catch(async () => assert.fail(`the player saw the pause: ${await tabs()}`));
  await dev.waitForFunction(() => window.arenaDebug().paused, null, { timeout: 5000 })
    .catch(async () => assert.fail(`the dev tab saw the pause: ${await tabs()}`));
  await page.waitForTimeout(300);
  assert.equal(room.match.tick, pausedAt, 'a paused room does not advance');
  await dev.screenshot({ path: 'test-results/dev-paused.png' });
  await dev.keyboard.press('Space');
  await until(() => room.pausedAt == null && room.match.tick > pausedAt, () => 'Space resumed the room');
  await page.waitForFunction(() => !window.arenaDebug().paused && document.getElementById('paused-banner').hidden);
  await dev.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['step out and back', 'dev view opens undelayed', 'free camera', 'follow in sight', 'fog toggle', 'pause and resume'] }));
} catch (error) { console.error('Browser errors:', errors); throw error; }
finally { await browser.close(); await server.close(); await rm(replayDir, { recursive: true, force: true }); }
