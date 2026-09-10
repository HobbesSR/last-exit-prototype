import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createArenaServer } from '../server/index.js';
import path from 'node:path';

await mkdir('test-results', { recursive: true });
const server = await createArenaServer({ replayDir: path.resolve('test-results/replays') });
await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.http.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
async function ready(page, url = base) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  if (await start.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) await start.click();
  await page.waitForFunction(() => window.arenaDebug?.().tick > 3, null, { timeout: 15000 });
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base);
  await page.getByRole('button', { name: 'Start match', exact: true }).waitFor();
  const ownerRoom = new URL(page.url()).searchParams.get('room');
  const ownerPlayer = await page.evaluate(() => window.arenaDebug().me.id);
  assert.equal(new URL(page.url()).searchParams.has('ownerKey'), false, 'invite URL contains no owner credential');
  await page.reload();
  await page.getByRole('button', { name: 'Start match', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('room'), ownerRoom, 'reload retains room and owner controls');
  assert.equal(await page.evaluate(() => window.arenaDebug().me.id), ownerPlayer, 'reload resumes the same player');
  await ready(page, page.url());
  const before = await page.evaluate(() => window.arenaDebug().me.x);
  await page.keyboard.down('KeyD'); await page.waitForTimeout(650); await page.keyboard.up('KeyD');
  const after = await page.evaluate(() => window.arenaDebug().me.x);
  assert.ok(after > before + 40, `keyboard movement ${before} -> ${after}`);
  // An ability press travels client input tick -> server tick -> broadcast, which can exceed a fixed
  // 100 ms pause on a coarse platform timer. Wait for the authoritative cooldown instead of guessing.
  await page.keyboard.press('KeyQ');
  assert.equal(await page.locator('#skill').isVisible(), false, 'contestants have no innate skill');
  await page.keyboard.press('Digit3');
  await page.waitForFunction(() => window.arenaDebug().me.selectedSlot === 2, null, { timeout: 5000 });
  await page.keyboard.press('Digit1');
  await page.waitForFunction(() => window.arenaDebug().me.selectedSlot === 0);
  await page.getByRole('button', { name: 'Drop selected', exact: false }).click();
  await page.waitForFunction(() => window.arenaDebug().me.inventory[0] === null);
  await page.screenshot({ path: 'test-results/desktop.png' });
  await page.getByRole('button', { name: 'Toggle local zoom', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/arena-overview.png' });
  const view = await page.evaluate(() => window.arenaDebug());
  assert.ok(view.mapWidth > view.cameraWidth * 3, 'live camera never exposes the full map');
  assert.ok(view.vision.length >= 100, 'obstacle-clipped visibility polygon');
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#game canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    if (!gl) throw new Error('Expected a WebGL canvas');
    const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const colors = new Set(); let lit = 0;
    for (let i = 0; i < data.length; i += 32) { colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`); if (data[i] + data[i + 1] + data[i + 2] > 250) lit++; }
    return { colors: colors.size, lit };
  });
  assert.ok(pixels.colors > 150 && pixels.lit > 1000, JSON.stringify(pixels));
  const joinUrl = page.url();
  const guest = await browser.newPage(); await guest.goto(joinUrl);
  await guest.waitForFunction(() => window.arenaDebug?.().me);
  assert.equal(await guest.evaluate(() => window.arenaDebug().room), await page.evaluate(() => window.arenaDebug().room));
  await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await page.getByRole('button', { name: 'End match & save replay' }).click();
  await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().click();
  await page.waitForFunction(() => window.arenaDebug().replay);
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await page.locator('#replay-seek').fill('5');
  assert.equal(await page.evaluate(() => window.arenaDebug().tick), 5);
  await page.screenshot({ path: 'test-results/replay.png' });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download replay', exact: true }).click();
  assert.match((await downloadPromise).suggestedFilename(), /^last-exit-.*\.json$/);
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByRole('button', { name: 'New arena', exact: true }).click();
  await page.getByRole('button', { name: 'Gladiator', exact: true }).click();
  await page.locator('#kit').selectOption('striker');
  await page.screenshot({ path: 'test-results/loadout.png' });
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().me?.kit === 'striker' && window.arenaDebug().me?.role === 'gladiator');
  await page.waitForTimeout(300); await page.screenshot({ path: 'test-results/gladiator.png' });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await ready(mobile);
  const mx = await mobile.evaluate(() => window.arenaDebug().me.x);
  const move = await mobile.getByRole('group', { name: 'Movement stick', exact: true }).boundingBox();
  await mobile.mouse.move(move.x + move.width / 2, move.y + move.height / 2); await mobile.mouse.down(); await mobile.mouse.move(move.x + move.width - 8, move.y + move.height / 2); await mobile.waitForTimeout(400); await mobile.mouse.up();
  assert.ok((await mobile.evaluate(() => window.arenaDebug().me.x)) > mx);
  const aim = await mobile.getByRole('group', { name: 'Aim and fire stick', exact: true }).boundingBox();
  await mobile.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2); await mobile.mouse.down(); await mobile.mouse.move(aim.x + aim.width / 2, aim.y + 5); await mobile.waitForTimeout(120);
  assert.ok(Math.abs((await mobile.evaluate(() => window.arenaDebug().aim)) + Math.PI / 2) < 0.1);
  await mobile.mouse.up();
  await mobile.screenshot({ path: 'test-results/mobile.png' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole('button', { name: 'New arena', exact: true }).click();
  await mobile.screenshot({ path: 'test-results/mobile-loadout.png' });
  await mobile.getByRole('button', { name: 'Close', exact: true }).first().click();
  const portraitChecks = await mobile.evaluate(() => [...document.images].filter(i => i.offsetParent !== null).every(i => i.complete && i.naturalWidth > 0));
  assert.ok(portraitChecks);
  const cdp = await mobile.context().newCDPSession(mobile);
  const leftStick = await mobile.locator('#move-stick').boundingBox(), rightStick = await mobile.locator('#aim-stick').boundingBox();
  const leftPoint = { id: 1, x: leftStick.x + leftStick.width / 2, y: leftStick.y + leftStick.height / 2 };
  const rightPoint = { id: 2, x: rightStick.x + rightStick.width / 2, y: rightStick.y + rightStick.height / 2 };
  const startTouchX = await mobile.evaluate(() => window.arenaDebug().me.x);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [leftPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [leftPoint, rightPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...leftPoint, x: leftPoint.x + 35 }, { ...rightPoint, y: rightPoint.y - 35 }] });
  await mobile.waitForTimeout(350);
  const touchState = await mobile.evaluate(() => window.arenaDebug());
  assert.ok(touchState.me.x > startTouchX + 20 && Math.abs(touchState.me.heading + Math.PI / 2) < 0.1, 'simultaneous move and aim');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const vr = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":4217}' })).json();
  const geometryGame = server.rooms.get(vr.id).game;
  for (const p of geometryGame.players) p.bot = false;
  Object.assign(geometryGame.players[0], { bot: true, x: 11980, y: 6000, weapon: 1, selectedSlot: 0, inventory: [{ kind: 'weapon', weaponType: 'pistol' }, null, null, null, null] });
  geometryGame.map.gates = []; geometryGame.map.buildings = []; geometryGame.map.traps = []; geometryGame.map.items = [];
  geometryGame.map.obstacles = [{ id: 'visibility-fixture', kind: 'container', color: 0, x: 12080, y: 5930, w: 60, h: 140 }];
  const visionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await ready(visionPage, `${base}/?room=${vr.id}&ownerKey=${encodeURIComponent(vr.ownerKey)}`);
  await visionPage.mouse.move(1100, 420);
  // The camera eases toward the player over several frames, so a fixed pause here raced that ease
  // and compared a settled aim against a still-moving viewport. Sample once the camera has stopped.
  await visionPage.waitForFunction(() => {
    const { x, y } = window.arenaDebug().camera, previous = window.cameraProbe;
    window.cameraProbe = { x, y };
    return previous && Math.abs(previous.x - x) < 0.01 && Math.abs(previous.y - y) < 0.01;
  }, null, { timeout: 5000 });
  await visionPage.waitForTimeout(150);
  const aiming = await visionPage.evaluate(() => {
    const d = window.arenaDebug();
    const rect = document.querySelector('#game canvas').getBoundingClientRect();
    return { actual: d.me.heading, expected: Math.atan2(d.camera.y + (420 - rect.top) / d.camera.zoom - d.me.y, d.camera.x + (1100 - rect.left) / d.camera.zoom - d.me.x) };
  });
  assert.ok(Math.abs(aiming.actual - aiming.expected) < 0.03, `mouse aim follows pointer independently of movement: ${JSON.stringify(aiming)}`);
  const occlusion = await visionPage.evaluate(() => {
    const d = window.arenaDebug(), canvas = document.querySelector('#game canvas'), gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    const sample = (x, y) => { const px = Math.round((x - d.camera.x) * d.camera.zoom), py = Math.round((y - d.camera.y) * d.camera.zoom); const rgba = new Uint8Array(4); gl.readPixels(px, gl.drawingBufferHeight - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); return [...rgba].slice(0, 3); };
    return { front: sample(12020, 6000), behind: sample(12220, 6000) };
  });
  // Cover is no longer cut away: what is out of sight is drawn and shaded, so the far side must be
  // darker than the lit side yet still not the bare camera background.
  const brightness = c => c[0] + c[1] + c[2];
  assert.ok(brightness(occlusion.front) > brightness(occlusion.behind) + 25, `lit cover outshines shade: ${JSON.stringify(occlusion)}`);
  assert.notDeepEqual(occlusion.behind, [22, 42, 41], 'terrain behind cover is shaded, not erased');
  await visionPage.screenshot({ path: 'test-results/occlusion.png' });
  // Projectiles only move on authoritative frames, so they must be advanced by the elapsed fraction of
  // a tick or they visibly step at 20 Hz. Sample consecutive rendered frames inside one tick.
  await visionPage.mouse.down();
  await visionPage.waitForFunction(() => window.arenaDebug().shots?.length > 0, null, { timeout: 8000 });
  const shotSamples = await visionPage.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 16; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const d = window.arenaDebug();
      out.push({ tick: d.tick, shot: d.shots?.[0] ?? null });
    }
    return out;
  });
  await visionPage.mouse.up();
  let advanced = 0, sameTickPairs = 0;
  for (let i = 1; i < shotSamples.length; i++) {
    const before = shotSamples[i - 1], after = shotSamples[i];
    if (!before.shot || !after.shot || before.shot.id !== after.shot.id || before.tick !== after.tick) continue;
    sameTickPairs++;
    if (Math.hypot(after.shot.x - before.shot.x, after.shot.y - before.shot.y) > 0.5) advanced++;
  }
  assert.ok(sameTickPairs > 0, `saw repeated ticks to compare: ${JSON.stringify(shotSamples)}`);
  assert.equal(advanced, sameTickPairs, `every shot advances between authoritative frames: ${JSON.stringify(shotSamples)}`);
  // The server now sends anything within reach; the client alone decides what is drawn. An enemy
  // standing behind cover must arrive in the state and still never be rendered.
  const lurker = geometryGame.players.find(p => p.role === 'gladiator');
  Object.assign(lurker, { x: 12200, y: 6000, bot: false, input: {} });
  await visionPage.waitForFunction(id => window.arenaDebug().actors?.some(a => a.id === id), lurker.id, { timeout: 8000 });
  const behindCover = await visionPage.evaluate(id => window.arenaDebug().actors.find(a => a.id === id), lurker.id);
  assert.equal(behindCover.visible, false, 'an enemy behind cover is transmitted but not drawn');
  Object.assign(lurker, { x: 12035, y: 6000 });
  await visionPage.waitForFunction(id => window.arenaDebug().actors?.find(a => a.id === id)?.visible === true, lurker.id, { timeout: 8000 });
  const inTheOpen = await visionPage.evaluate(id => window.arenaDebug().actors.find(a => a.id === id), lurker.id);
  assert.equal(inTheOpen.visible, true, 'the same enemy in the open is drawn');
  const runnerId = await visionPage.evaluate(() => window.arenaDebug().me.id);
  const runner = geometryGame.players.find(p => p.id === runnerId);
  runner.x = 15000; runner.y = 6000; geometryGame.map.traps = [];
  lurker.x = 15720; lurker.y = 6300;
  await visionPage.getByRole('button', { name: 'Toggle local zoom', exact: true }).click();
  await visionPage.waitForFunction(id => window.arenaDebug().me.x > 14900 && window.arenaDebug().actors.find(a => a.id === id)?.visible, lurker.id);
  assert.ok(Math.hypot(lurker.x - runner.x, lurker.y - runner.y) > 620, 'visible actor is beyond the former circular cutoff');
  await visionPage.screenshot({ path: 'test-results/viewport-visibility.png' });
  runner.inventory[1] = { kind: 'cell', charge: 99 }; Object.assign(runner, { x: geometryGame.map.chargers[1].x, y: geometryGame.map.chargers[1].y });
  await visionPage.waitForFunction(() => window.arenaDebug().me.inventory?.[1]?.charge === 99);
  await visionPage.keyboard.press('KeyE');
  await visionPage.waitForFunction(() => document.getElementById('objective').textContent.includes('CELL CHARGED'));
  Object.assign(runner, geometryGame.map.exit);
  await visionPage.waitForFunction(x => Math.abs(window.arenaDebug().me.x - x) < 1, geometryGame.map.exit.x);
  await visionPage.keyboard.press('KeyE');
  await visionPage.waitForFunction(() => window.arenaDebug().me.status === 'escaped');
  const caster = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await ready(caster);
  await caster.evaluate(() => window.arenaSpectate());
  // connect() clears the local player id before the socket opens, so wait on the spectator welcome itself.
  await caster.waitForFunction(() => document.getElementById('connection-text').textContent === 'SPECTATING' && window.arenaDebug().tick > 0, null, { timeout: 15000 });
  const cast = await caster.evaluate(() => ({ ...window.arenaDebug(), hud: document.getElementById('live-hud').hidden, status: document.getElementById('connection-text').textContent }));
  assert.equal(cast.directed, true); assert.equal(cast.me, undefined); assert.equal(cast.hud, true); assert.equal(cast.status, 'SPECTATING');
  assert.equal(cast.vision, null, 'a directed view computes no personal visibility polygon');
  assert.ok(cast.cameraWidth >= cast.mapWidth, `directed camera frames the whole arena: ${cast.cameraWidth} vs ${cast.mapWidth}`);
  await caster.screenshot({ path: 'test-results/spectator.png' });
  const artRoom = server.rooms.get(await page.evaluate(() => window.arenaDebug().room));
  const artId = await page.evaluate(() => window.arenaDebug().me.id);
  const artPlayer = artRoom.game.players.find(p => p.id === artId);
  const interior = artRoom.game.map.buildings[0];
  Object.assign(artPlayer, { x: interior.x + 125, y: interior.y + 125 });
  await page.waitForFunction(x => Math.abs(window.arenaDebug().me.x - x) < 1, interior.x + 125);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/ruins.png' });
  assert.equal(await page.evaluate(id => window.arenaDebug().roofs.find(r => r.id === id).visible, interior.id), false, 'roof hides while inside');
  Object.assign(artPlayer, { x: interior.x + 125, y: interior.y + 305 });
  await page.waitForFunction(id => window.arenaDebug().roofs.find(r => r.id === id)?.visible, interior.id);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/building-roof.png' });
  artPlayer.keys = 1;
  await page.keyboard.press('KeyE');
  await page.keyboard.down('KeyW'); await page.waitForTimeout(850); await page.keyboard.up('KeyW');
  await page.waitForFunction(id => window.arenaDebug().roofs.find(r => r.id === id)?.visible === false, interior.id);
  assert.ok(artPlayer.y < interior.y + interior.h, 'opened door and walked into a real building');
  await guest.close(); await mobile.close(); await visionPage.close(); await caster.close();
  await page.getByRole('button', { name: 'New arena', exact: true }).click();
  await page.locator('#matchmaking').check(); await page.locator('#role-preference').selectOption('gladiator');
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('lobby-dialog').open && window.arenaDebug().me?.role === 'gladiator');
  const matchedRoom = await page.evaluate(() => window.arenaDebug().room);
  assert.equal(server.rooms.get(matchedRoom).matchmade, true);
  assert.equal(await page.locator('#start-match').isVisible(), false);
  server.rooms.get(matchedRoom).startsAt = Date.now() - 1;
  await page.waitForFunction(() => !document.getElementById('lobby-dialog').open && window.arenaDebug().tick > 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, pixels, occlusion, screenshots: ['desktop', 'arena-overview', 'replay', 'loadout', 'gladiator', 'mobile', 'mobile-loadout', 'occlusion', 'spectator'], checks: ['movement', 'ability', 'multiplayer', 'replay seek', 'download', 'kit selection', 'dual-stick multitouch', 'mouse aim', 'occlusion pixels', 'shade not blackout', 'client-side visibility', 'shot interpolation', 'spectator directed view', 'mobile overflow', 'assets', 'browser errors'] }, null, 2));
} catch (error) { console.error('Browser errors:', errors); throw error; }
finally { await browser.close(); await server.close(); }
