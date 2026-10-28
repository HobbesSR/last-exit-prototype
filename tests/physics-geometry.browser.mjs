// The experimental content's display circles are visible only in an authorized dev view.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { serveWithBrowser } from './helpers/browser.js';
import { listen } from './helpers/listen.js';
import { contentById } from '../shared/simulation/content.ts';
import { createMatch, createPhysicsMatch } from '../server/match.js';

const scratch = path.resolve('test-results');
await mkdir(scratch, { recursive: true });
const replayDir = await mkdtemp(path.join(scratch, 'physics-geometry-'));
const { server, base, browser } = await serveWithBrowser({ replayDir, content: () => contentById('content-physics-2'), matchFactory: createPhysicsMatch,
  devTools: 'all', profileSummary: false });
const errors = [];
const expected = contentById('content-physics-2').actorPhysics.geometry.contestant;
const color = { headRadius: 0x79d7ff, bodyRadius: 0xffd46d, hurtRadius: 0xff6d9a };
function checkCircles(frame) {
  assert.equal(frame.geometry.visible, true);
  assert.ok(frame.marker > 0);
  assert.ok(Math.abs(frame.marker * frame.geometry.scale - 1) < 1e-9, 'overlay cancels marker scaling');
  const commands = frame.geometry.commands;
  for (const [key, ink] of Object.entries(color)) {
    const at = commands.indexOf(ink);
    assert.ok(at > 0, `${key} circle is drawn in its own color`);
    assert.equal(commands[at + 6], expected[key], `${key} uses the content radius in world units`);
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.arenaDebug?.().content === 'content-physics-2' && window.arenaDebug().actors?.length);
  const initial = await page.evaluate(() => { const d = window.arenaDebug(); return { dev: d.dev, geometry: d.actors[0].geometry }; });
  assert.equal(initial.dev, false);
  assert.equal(initial.geometry.visible, false);
  assert.deepEqual(initial.geometry.commands, []);
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().version === 'last-exit-0.8-physics-2');
  assert.ok((await page.evaluate(() => window.arenaDebug())).actors.every(a => !a.geometry.visible),
    'physics match still hides geometry from ordinary players');
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().actors?.some(a => a.geometry.visible));
  const dev = await page.evaluate(() => { const d = window.arenaDebug(); return { dev: d.dev, marker: d.markerScale, geometry: d.actors[0].geometry }; });
  assert.equal(dev.dev, true);
  assert.equal(await page.evaluate(() => window.arenaDebug().version), 'last-exit-0.8-physics-2');
  checkCircles(dev);
  await page.mouse.move(500, 350);
  await page.mouse.wheel(0, -1500);
  await page.waitForFunction(marker => window.arenaDebug().markerScale < marker - 0.1, dev.marker);
  const zoomed = await page.evaluate(() => { const d = window.arenaDebug(); return { marker: d.markerScale, geometry: d.actors[0].geometry }; });
  assert.notEqual(zoomed.marker, dev.marker, 'zoom changes the marker scale');
  checkCircles(zoomed);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().actors?.every(a => !a.geometry.visible));
  const returned = await page.evaluate(() => window.arenaDebug().actors[0].geometry);
  assert.equal(returned.visible, false, 'stepping back to the player view hides the overlay');
  assert.deepEqual(returned.commands, [], 'ordinary view exposes no geometry draw commands');

  // A room can carry the same experimental descriptor while using the legacy match factory.
  // Its bodies still use legacy movement, so the geometry circles must stay hidden even in dev view.
  const legacyReplayDir = await mkdtemp(path.join(scratch, 'legacy-geometry-'));
  const legacyServer = await createArenaServer({ replayDir: legacyReplayDir,
    content: () => contentById('content-physics-2'), matchFactory: createMatch, devTools: 'all', profileSummary: false });
  try {
    const legacyBase = await listen(legacyServer);
    const legacy = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    legacy.on('pageerror', error => errors.push(error.message));
    await legacy.goto(legacyBase);
    await legacy.waitForFunction(() => window.arenaDebug?.().content === 'content-physics-2');
    await legacy.getByRole('button', { name: 'Start match', exact: true }).click();
    await legacy.waitForFunction(() => window.arenaDebug().phase === 'live');
    assert.notEqual(await legacy.evaluate(() => window.arenaDebug().version), 'last-exit-0.8-physics-2');
    await legacy.getByRole('button', { name: 'Dev view', exact: true }).click();
    await legacy.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().actors?.length);
    assert.ok((await legacy.evaluate(() => window.arenaDebug())).actors.every(a => !a.geometry.visible && !a.geometry.commands.length),
      'a legacy match never displays experimental body geometry');
  } finally { await legacyServer.close(); await rm(legacyReplayDir, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
  console.log('Physics geometry browser checks passed');
} finally {
  await browser.close();
  await server.close();
  await rm(replayDir, { recursive: true, force: true });
}
