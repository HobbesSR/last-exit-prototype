// The experimental content's display circles are visible only in an authorized dev view.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { serveWithBrowser } from './helpers/browser.js';
import { listen } from './helpers/listen.js';
import { contentById } from '../shared/simulation/content.ts';
import { createPhysicsMatch } from '../server/match.js';
import { PHYSICS_VERSION } from '../shared/simulation.ts';

const scratch = path.resolve('test-results');
await mkdir(scratch, { recursive: true });
const replayDir = await mkdtemp(path.join(scratch, 'physics-geometry-'));
const { server, base, browser } = await serveWithBrowser({ replayDir, content: () => contentById('content-6'), matchFactory: createPhysicsMatch,
  devTools: 'all', profileSummary: false });
const errors = [];
const expected = contentById('content-6').actorPhysics.geometry.contestant;
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
  await page.waitForFunction(() => window.arenaDebug?.().content === 'content-6' && window.arenaDebug().actors?.length);
  const initial = await page.evaluate(() => { const d = window.arenaDebug(); return { dev: d.dev, geometry: d.actors[0].geometry }; });
  assert.equal(initial.dev, false);
  assert.equal(initial.geometry.visible, false);
  assert.deepEqual(initial.geometry.commands, []);
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(version => window.arenaDebug().phase === 'live' && window.arenaDebug().version === version, PHYSICS_VERSION);
  assert.ok((await page.evaluate(() => window.arenaDebug())).actors.every(a => !a.geometry.visible),
    'physics match still hides geometry from ordinary players');
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().actors?.some(a => a.geometry.visible));
  const dev = await page.evaluate(() => { const d = window.arenaDebug(); return { dev: d.dev, marker: d.markerScale, geometry: d.actors[0].geometry }; });
  assert.equal(dev.dev, true);
  assert.equal(await page.evaluate(() => window.arenaDebug().version), PHYSICS_VERSION);
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

  assert.deepEqual(errors, []);
  console.log('Physics geometry browser checks passed');
} finally {
  await browser.close();
  await server.close();
  await rm(replayDir, { recursive: true, force: true });
}
