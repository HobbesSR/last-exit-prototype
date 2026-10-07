import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createArenaServer } from '../server/index.js';
import { generateMap } from '../shared/map.ts';
import { listen } from './helpers/listen.js';
import path from 'node:path';
import { checkClientControllers } from './client-controllers.mjs';
import { createMapGenerator } from '../server/map-generator.js';

await mkdir('test-results', { recursive: true });
// The real worker, except that a check can hold the next generation and fail it when it chooses.
const maps = createMapGenerator();
let holdNextGeneration = false, failHeldGeneration = null;
const failableMaps = (seed, size) => {
  if (!holdNextGeneration) return maps.generate(seed, size);
  holdNextGeneration = false;
  return new Promise((_resolve, reject) => { failHeldGeneration = () => reject(new Error('generation failure arranged by the browser suite')); });
};
const server = await createArenaServer({ replayDir: path.resolve('test-results/replays'), generateMap: failableMaps });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
/** Wait until a player has stopped moving on the server and the page shows them where they stopped. */
async function settled(page, player, timeout = 10000) {
  let last = null;
  for (let waited = 0; waited < timeout; waited += 100) {
    const now = { x: player.x, y: player.y }, shown = await page.evaluate(() => window.arenaDebug().me);
    if (last && last.x === now.x && last.y === now.y && Math.hypot(shown.x - now.x, shown.y - now.y) < 1) return now;
    last = now; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`player never settled: server ${JSON.stringify({ x: player.x, y: player.y })}`);
}
async function ready(page, url = base) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  if (await start.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) await start.click();
  await page.waitForFunction(() => window.arenaDebug?.().phase === 'live' && window.arenaDebug().tick > 3, null, { timeout: 15000 });
}
try {
  await checkClientControllers(browser, base);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${base}/?seed=4217`);
  await page.getByRole('button', { name: 'Start match', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#lobby-count')?.textContent === '1/8 contestants / 0/3 gladiators');
  const ownerRoom = new URL(page.url()).searchParams.get('room');
  // The lobby opens before the map exists (#258), with the player already in the waiting yard (#236).
  const myId = async () => (await page.waitForFunction(() => window.arenaDebug().me?.id, null, { timeout: 120000 })).jsonValue();
  const ownerPlayer = await myId();
  // Until the start players walk about a waiting yard (#236): the lobby stays open and the arena hidden.
  await page.waitForFunction(() => window.arenaDebug().phase === 'waiting');
  assert.equal(await page.evaluate(() => window.arenaDebug().map.width), 1400, 'the yard, not the arena');
  const waitingX = await page.evaluate(() => window.arenaDebug().me.x);
  await page.keyboard.down('KeyD'); await page.waitForTimeout(650); await page.keyboard.up('KeyD');
  await page.waitForFunction(x => window.arenaDebug().me.x > x + 40, waitingX, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('lobby-dialog').open), true, 'walking leaves the lobby open');
  await page.screenshot({ path: 'test-results/waiting-yard.png' });
  assert.equal(new URL(page.url()).searchParams.has('ownerKey'), false, 'invite URL contains no owner credential');
  await page.reload();
  await page.getByRole('button', { name: 'Start match', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('room'), ownerRoom, 'reload retains room and owner controls');
  assert.equal(await myId(), ownerPlayer, 'reload resumes the same player');
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
  assert.equal(await page.locator('#equipment-slots button').count(), 6);
  assert.ok(await page.locator('#equipment-slots button svg').count() > 0, 'equipment uses icons');
  await page.getByRole('button', { name: 'Move or merge selected item', exact: true }).click();
  await page.locator('#equipment-slots button').nth(5).click();
  await page.waitForFunction(() => window.arenaDebug().me.inventory[5]?.kind === 'weapon' && window.arenaDebug().me.selectedSlot === 5);
  await page.keyboard.press('KeyR'); await page.keyboard.press('Digit1');
  await page.waitForFunction(() => window.arenaDebug().me.inventory[0]?.kind === 'weapon' && window.arenaDebug().me.selectedSlot === 0);
  await page.getByRole('button', { name: 'Drop selected', exact: false }).click();
  await page.waitForFunction(() => window.arenaDebug().me.inventory[0] === null);
  // Real pointer gestures travel through the client, wire validation and fixed tick.
  const inventoryPlayer = server.rooms.get(ownerRoom).game.players.find(p => p.id === ownerPlayer);
  inventoryPlayer.inventory[5] = { kind: 'weapon', weaponType: 'rifle', ammo: 7 };
  inventoryPlayer.selectedSlot = 0;
  await page.waitForFunction(() => window.arenaDebug().me.inventory[5]?.ammo === 7);
  const slotCenter = async index => {
    const box = await page.locator('#equipment-slots button').nth(index).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const dragInventory = async (from, to) => {
    const source = await slotCenter(from);
    await page.mouse.move(source.x, source.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  };
  await dragInventory(5, await slotCenter(4));
  await page.waitForFunction(() => window.arenaDebug().me.inventory[4]?.ammo === 7 && !window.arenaDebug().me.inventory[5]);
  await page.keyboard.press('Digit1');
  await page.waitForFunction(() => window.arenaDebug().me.selectedSlot === 0);
  const arenaBox = await page.locator('#game canvas').boundingBox();
  await dragInventory(4, { x: arenaBox.x + arenaBox.width / 2, y: arenaBox.y + arenaBox.height / 2 });
  await page.waitForFunction(() => window.arenaDebug().me.inventory[4] === null);
  const gestureDrop = server.rooms.get(ownerRoom).game.map.items.find(item => item.droppedBy === ownerPlayer && item.weaponType === 'rifle');
  assert.equal(gestureDrop?.ammo, 7, 'world drag drops the unselected source with its ammunition');
  await page.screenshot({ path: 'test-results/desktop.png' });
  
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
  // Deliberately stall a frame. Diagnostics must preserve the spike, not Phaser's smoothed delta.
  await page.evaluate(() => { const end = performance.now() + 120; while (performance.now() < end) {} });
  await page.waitForTimeout(100);
  const diagnosticDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download performance diagnostics', exact: true }).click();
  const diagnosticFile = await diagnosticDownload;
  const diagnosticStream = await diagnosticFile.createReadStream(), diagnosticChunks = [];
  for await (const chunk of diagnosticStream) diagnosticChunks.push(chunk);
  const diagnostic = JSON.parse(Buffer.concat(diagnosticChunks).toString());
  assert.ok(diagnostic.timings.frameMs.max >= 100, 'raw frame capture includes long stalls');
  assert.equal(Object.hasOwn(diagnostic, 'ownerKey'), false);
  assert.equal(Object.hasOwn(diagnostic, 'players'), false);
  assert.equal(diagnostic.server.ok, true);
  await page.getByRole('button', { name: 'End match & save replay' }).click();
  await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().waitFor();
  // Playback follows the wall clock, so these deadlines are real time plus headroom for the coarse
  // frames this suite renders at -- headless frames here run about 240 ms, so a tick becomes visible
  // up to a frame after playback reaches it.
  const PLAYBACK_DEADLINE = 10000;
  // Keep the archive's normal dense recording path covered too: real playback
  // must advance authoritative state before the routed sparse fixture below.
  await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().click();
  await page.waitForFunction(() => window.arenaDebug().replay);
  await page.waitForFunction(() => window.arenaDebug().tick >= 16, null, { timeout: PLAYBACK_DEADLINE });
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await page.locator('#replay-seek').fill('5');
  assert.equal(await page.evaluate(() => window.arenaDebug().tick), 5);
  // A replay opens on the whole arena, where an unscaled contestant covers about three pixels, so
  // markers are enlarged to hold their apparent size. Choosing a subject cuts to that player's own
  // zoom and draws markers at life size again.
  const wide = await page.evaluate(() => window.arenaDebug());
  assert.equal(await page.locator('#replay-focus option[value="g2"]').count(), 1, 'the third hunter remains selectable in recorded playback');
  assert.ok(wide.actors.some(actor => actor.id === 'g2' && actor.visible), 'the third hunter is drawn in replay');
  assert.ok(wide.cameraWidth >= wide.mapWidth, `replay opens on the whole arena: ${wide.cameraWidth} vs ${wide.mapWidth}`);
  assert.ok(wide.markerScale > 4, `whole arena markers are enlarged: ${wide.markerScale}`);
  const subject = await page.locator('#replay-focus option').nth(1).getAttribute('value');
  await page.locator('#replay-focus').selectOption(subject);
  await page.waitForFunction(id => window.arenaDebug().follow === id && window.arenaDebug().markerScale === 1, subject, { timeout: 5000 });
  const following = await page.evaluate(() => window.arenaDebug());
  const target = following.actors.find(actor => actor.id === subject);
  assert.ok(following.mapWidth > following.cameraWidth * 3, `a followed camera shows a player view: ${following.cameraWidth} vs ${following.mapWidth}`);
  assert.ok(Math.abs(following.camera.x + following.cameraWidth / 2 - target.x) < 60
    && Math.abs(following.camera.y + following.cameraHeight / 2 - target.y) < 60,
    `the followed camera centres on its subject: ${JSON.stringify({ camera: following.camera, target })}`);
  await page.locator('#replay-focus').selectOption('');
  await page.waitForFunction(width => window.arenaDebug().cameraWidth >= width, wide.mapWidth, { timeout: 5000 });
  const denseDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download replay', exact: true }).click();
  assert.match((await denseDownloadPromise).suggestedFilename(), /^last-exit-.*\.json$/);
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByRole('button', { name: 'Replays', exact: true }).click();
  // Routed archives keep the real map contract while making playback deterministic.
  // The dense fixture covers continuous render time; the sparse one covers omitted
  // frames, which must hold the last retained state rather than extrapolate through
  // data that was never saved. Projectiles advance ten units per tick, so a rendered
  // position states both the authoritative tick and the fraction into it.
  const savedRecording = await (await fetch(`${base}/api/replays/${ownerRoom}`)).json();
  const fixtureState = tick => {
    const state = structuredClone(savedRecording.frames[0].state);
    const origin = state.players[0];
    state.tick = tick;
    state.projectiles = [{ id: 'fixture-shot', x: origin.x + tick * 10, y: origin.y, dx: 10, dy: 0 }];
    state.effects = [];
    return state;
  };
  const originX = fixtureState(0).projectiles[0].x;
  const denseReplay = {
    ...savedRecording,
    frames: Array.from({ length: 61 }, (_, tick) => ({ state: fixtureState(tick), commands: [] })),
    recording: { complete: true, droppedFrames: 0, endTick: 60 }
  };
  const sparseReplay = {
    ...savedRecording,
    frames: [0, 8, 16, 24].map(tick => ({ state: fixtureState(tick), commands: [] })),
    recording: { complete: false, droppedFrames: 20, endTick: 30 }
  };
  let routedReplay = denseReplay;
  await page.route(`**/api/replays/${ownerRoom}`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(routedReplay) }));
  const openRoutedReplay = async () => {
    await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Play arena 4217', exact: true }).first().click();
    await page.waitForFunction(() => window.arenaDebug().replay);
  };
  // A headless frame is longer than a playback tick, so no assertion may assume a
  // sample lands in a chosen tick. Sample whatever frames occur and check the
  // invariant that must hold for every one of them.
  const samplePlayback = frames => page.evaluate(async count => {
    const samples = [];
    for (let i = 0; i < count; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const debug = window.arenaDebug(), status = document.getElementById('replay-status');
      samples.push({ tick: debug.tick, seek: Number(document.getElementById('replay-seek').value),
        x: debug.shots?.[0]?.x, status: status.hidden ? null : status.textContent });
    }
    return samples;
  }, frames);
  const pausePlayback = () => page.evaluate(() => {
    const button = document.getElementById('replay-play');
    if (button.ariaLabel === 'Pause replay') button.click();
  });
  await openRoutedReplay();
  await pausePlayback();
  await page.locator('#replay-speed').selectOption('0.5');
  await page.locator('#replay-seek').fill('0');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  const denseSamples = await samplePlayback(6);
  await pausePlayback();
  // Dense playback keeps fractional render time: every frame shows the floored
  // authoritative tick with the projectile advanced part way into it. Rejecting
  // fractional lookups froze both the state and the seek position instead.
  const report = samples => JSON.stringify(samples);
  for (const sample of denseSamples) {
    assert.equal(sample.tick, sample.seek, `dense playback shows the floored tick: ${report(denseSamples)}`);
    assert.equal(sample.status, null, `a complete recording shows no gap notice: ${report(denseSamples)}`);
    assert.ok(sample.x >= originX + sample.tick * 10 && sample.x < originX + sample.tick * 10 + 10,
      `dense frame alpha stays inside its own tick: ${report(denseSamples)}`);
  }
  assert.ok(denseSamples.at(-1).tick > denseSamples[0].tick, `dense playback advances ticks: ${report(denseSamples)}`);
  assert.ok(denseSamples.some(sample => sample.x > originX + sample.tick * 10),
    `dense playback renders between authoritative ticks: ${report(denseSamples)}`);
  // Playback must follow the wall clock rather than accumulating render deltas: a viewer whose
  // frames are long still has to get the speed they selected. Accumulating Phaser's smoothed delta
  // ran playback at roughly a tenth of real time here, and nothing caught it because no assertion
  // compared playback against elapsed time.
  await page.locator('#replay-seek').fill('0');
  await page.locator('#replay-speed').selectOption('1');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  // Timed inside the page: driving the clock from the test would count Playwright's own round trips
  // as playback time, which in this suite runs to seconds.
  const clock = await page.evaluate(() => new Promise(resolve => {
    const from = window.arenaDebug().tick, at = performance.now();
    setTimeout(() => resolve({ ticks: window.arenaDebug().tick - from, ms: performance.now() - at }), 1500);
  }));
  await pausePlayback();
  const clockExpected = clock.ms / 1000 * 20;
  // Both readings floor a continuous playhead, so the tick count can overstate the elapsed playhead
  // by nearly a whole tick on its own — start at N.99 reported as N, end at M.01 reported as M — and
  // the two samples are not taken at the same instant. Two ticks of slack is that, not a loosened
  // guard: the regression this exists to catch ran playback at roughly a tenth of real time, which
  // lands far outside the lower bound regardless.
  assert.ok(clock.ticks > clockExpected * 0.6 && clock.ticks <= clockExpected + 2,
    `playback tracks wall time: advanced ${clock.ticks} ticks while ${clockExpected.toFixed(1)} elapsed`);
  routedReplay = sparseReplay;
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await openRoutedReplay();
  await pausePlayback();
  // Seeking into a sparse gap holds tick zero's projectile exactly and tells the
  // viewer which retained state is on screen.
  await page.locator('#replay-seek').fill('5');
  assert.equal(await page.evaluate(() => window.arenaDebug().tick), 0);
  assert.equal(await page.locator('#replay-status').textContent(), 'MISSING DATA · showing tick 0');
  assert.equal(await page.evaluate(() => window.arenaDebug().shots[0].x), originX, 'gaps do not advance held projectiles');
  // The same must hold while playing, not merely at an integer seek position: a
  // retained tick interpolates within itself, a gap holds its recorded position.
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  const gapSamples = await samplePlayback(6);
  await pausePlayback();
  for (const sample of gapSamples) {
    const held = originX + sample.tick * 10;
    if (sample.seek === sample.tick) {
      assert.equal(sample.status, 'PARTIAL RECORDING · 20 frames omitted', `retained sparse frames label the recording: ${report(gapSamples)}`);
      assert.ok(sample.x >= held && sample.x < held + 10, `retained sparse frames interpolate within their tick: ${report(gapSamples)}`);
    } else {
      assert.equal(sample.status, `MISSING DATA · showing tick ${sample.tick}`, `gaps name the retained tick on screen: ${report(gapSamples)}`);
      assert.equal(sample.x, held, `gaps never extrapolate a projectile: ${report(gapSamples)}`);
    }
  }
  assert.ok(gapSamples.some(sample => sample.seek !== sample.tick), `sparse playback rendered a gap: ${report(gapSamples)}`);
  // Real onFrame playback supplies fractional ticks. Each supported speed must
  // advance to the next retained state, without asserting fragile timing.
  for (const speed of ['0.5', '1', '2', '4']) {
    await page.locator('#replay-seek').fill('0');
    await page.locator('#replay-speed').selectOption(speed);
    await page.getByRole('button', { name: 'Play replay', exact: true }).click();
    // What must hold is that every speed advances to the next retained state, not how long that
    // takes in wall time.
    await page.waitForFunction(() => window.arenaDebug().tick >= 8, null, { timeout: PLAYBACK_DEADLINE });
    await pausePlayback();
  }
  // Resume from a gap, then run to the declared tail. The final tail is also
  // missing data and therefore keeps the final retained projectile stationary.
  await page.locator('#replay-seek').fill('5');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(() => Number(document.getElementById('replay-seek').value) === 30, null, { timeout: PLAYBACK_DEADLINE });
  assert.equal(await page.locator('#replay-status').textContent(), 'MISSING DATA · showing tick 24');
  assert.equal(await page.evaluate(() => window.arenaDebug().shots[0].x), originX + 240, 'tail gap holds final projectile position');
  // Marks at one tick (a server stall and reports from two players) must each stay selectable: they
  // share a cluster pip that opens a list, and a lone mark elsewhere keeps its own pip.
  const [markA, markB] = denseReplay.frames[0].state.players.map(p => p.id);
  routedReplay = { ...denseReplay, diagnostics: { marks: [
    { tick: 40, kind: 'server-stall', wakeMs: 450, owed: 9, simulated: 5 },
    { tick: 40, kind: 'manual', playerId: markA }, { tick: 40, kind: 'manual', playerId: markB },
    { tick: 10, kind: 'frame-drop' }] } };
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await openRoutedReplay();
  await pausePlayback();
  assert.equal(await page.locator('#replay-marks button').count(), 2, 'a cluster pip and a lone pip');
  await page.locator('#replay-marks .mark-frame-drop').click();
  assert.equal(await page.evaluate(() => window.arenaDebug().tick), 0, 'a lone mark seeks two seconds early, clamped to the start');
  await page.locator('#replay-marks .mark-cluster').click();
  assert.equal(await page.locator('#replay-mark-menu button').count(), 3, 'every clustered mark is listed');
  await page.locator('#replay-mark-menu .mark-server-stall').click();
  assert.equal(await page.evaluate(() => window.arenaDebug().tick), Math.max(0, 40 - 2 * denseReplay.hz));
  assert.equal(await page.locator('#replay-mark-menu').isHidden(), true);
  await page.locator('#replay-marks .mark-cluster').click();
  await page.locator('#replay-mark-menu .mark-manual').nth(1).click();
  assert.equal(await page.locator('#replay-focus').inputValue(), String(markB), 'each report follows its own player');
  // Distinct nearby ticks collide on a narrow track, not just equal ones. At any width, every pip must
  // be the topmost element at its own centre, so none can be hidden or have its click intercepted.
  const pipsReachable = () => page.evaluate(() => [...document.querySelectorAll('#replay-marks button')].every(pip => {
    const box = pip.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === pip;
  }));
  routedReplay = { ...denseReplay, diagnostics: { marks: [{ tick: 10, kind: 'manual', playerId: markA }, { tick: 14, kind: 'manual', playerId: markB }] } };
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByRole('button', { name: 'Replays', exact: true }).click();
  await openRoutedReplay();
  await pausePlayback();
  assert.equal(await page.locator('#replay-marks button').count(), 2, 'a wide track keeps nearby ticks apart');
  assert.equal(await pipsReachable(), true, 'every pip is reachable on a wide track');
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForFunction(() => document.querySelectorAll('#replay-marks button').length === 1);
  assert.equal(await pipsReachable(), true, 'every pip is reachable on a narrow track');
  await page.locator('#replay-marks .mark-cluster').click();
  assert.equal(await page.locator('#replay-mark-menu button').count(), 2, 'both nearby marks stay selectable');
  await page.setViewportSize(wideViewport);
  await page.waitForFunction(() => document.querySelectorAll('#replay-marks button').length === 2);
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
  const mobileInfo = await mobile.evaluate(() => window.arenaDebug());
  const mobilePlayer = server.rooms.get(mobileInfo.room).game.players.find(p => p.id === mobileInfo.me.id);
  mobilePlayer.inventory[5] = { kind: 'weapon', weaponType: 'rifle', ammo: 7 };
  mobilePlayer.inventory[4] = null;
  await mobile.waitForFunction(() => window.arenaDebug().me.inventory[5]?.ammo === 7 && !window.arenaDebug().me.inventory[4]);
  const touchSlotCenter = async index => {
    const box = await mobile.locator('#equipment-slots button').nth(index).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 3 };
  };
  const sourceTouch = await touchSlotCenter(5), targetTouch = await touchSlotCenter(4);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [leftPoint] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [leftPoint, sourceTouch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [leftPoint, targetTouch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [targetTouch] });
  await mobile.waitForFunction(() => window.arenaDebug().me.inventory[4]?.ammo === 7 && !window.arenaDebug().me.inventory[5]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mobile.locator('#equipment-slots button').nth(0).tap();
  await mobile.waitForFunction(() => window.arenaDebug().me.selectedSlot === 0);
  const mobileCanvas = await mobile.locator('#game canvas').boundingBox();
  const worldTouch = { x: mobileCanvas.x + mobileCanvas.width / 2, y: mobileCanvas.y + mobileCanvas.height / 2, id: 3 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [targetTouch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [worldTouch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mobile.waitForFunction(() => window.arenaDebug().me.inventory[4] === null);
  assert.equal(server.rooms.get(mobileInfo.room).game.map.items.find(item => item.droppedBy === mobilePlayer.id && item.weaponType === 'rifle')?.ammo, 7, 'touch world drag preserves source ammo');
  const vr = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":4217}' })).json();
  await server.rooms.get(vr.id).ready;
  const geometryGame = server.rooms.get(vr.id).game;
  // Fixed-coordinate sight/projectile probes exercise the legacy recording geometry.
  // The normal rooms above and spectator below exercise the live chain map.
  geometryGame.map = generateMap(4217);
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
  // Let the receive buffer fill after joining, and shoot past the cover instead of
  // deleting the probe projectile against it after two ticks.
  await visionPage.waitForFunction(() => window.arenaDebug().tick >= 40);
  await visionPage.mouse.move(720, 180);
  await visionPage.waitForTimeout(150);
  await visionPage.mouse.down();
  await visionPage.waitForFunction(() => window.arenaDebug().shots?.length > 0, null, { timeout: 8000 });
  const shotSamples = await visionPage.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 16; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const d = window.arenaDebug();
      out.push({ tick: d.tick, shot: d.shots?.[0] ?? null, starved: d.buffer.starved, snaps: d.buffer.snaps });
    }
    return out;
  });
  await visionPage.mouse.up();
  let advanced = 0, sameTickPairs = 0;
  for (let i = 1; i < shotSamples.length; i++) {
    const before = shotSamples[i - 1], after = shotSamples[i];
    if (!before.shot || !after.shot || before.shot.id !== after.shot.id || before.tick !== after.tick) continue;
    // A frame drawn while the receive buffer was starved, or right after it resynchronised, holds or
    // jumps on purpose (25). Under load that happens, so it says nothing about interpolation.
    if (after.starved !== before.starved || after.snaps !== before.snaps) continue;
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
  // Several archetypes are in the catalogue, so every position here comes from the building rather
  // than a fixed offset: one lands inside a partition or a stack and the body is separated straight
  // back out, and the door is not in the same place in all of them.
  const entrance = artRoom.game.map.gates.find(g => g.buildingId && !g.locked && artRoom.game.map.items.some(i => i.buildingId === g.buildingId));
  const interior = artRoom.game.map.buildings.find(b => b.id === entrance.buildingId);
  const indoors = artRoom.game.map.items.find(i => i.buildingId === interior.id);
  Object.assign(artPlayer, { x: indoors.x, y: indoors.y });
  // The body may be separated out of a partition, so wait for wherever it settles rather than for the
  // exact spot: rooms have random seeds, so which buildings put loot against a partition varies.
  await settled(page, artPlayer);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/ruins.png' });
  assert.equal(await page.evaluate(id => window.arenaDebug().roofs.find(r => r.id === id).visible, interior.id), false, 'roof hides while inside');
  // Stand 55 outside the door, on whichever wall it is, and walk in through it. A gate's x and y are its centre.
  const doorX = entrance.x, doorY = entrance.y;
  const across = entrance.w > entrance.h, outward = across ? Math.sign(doorY - (interior.y + interior.h / 2)) : Math.sign(doorX - (interior.x + interior.w / 2));
  const approach = across ? { x: doorX, y: outward > 0 ? interior.y + interior.h + 55 : interior.y - 55, key: outward > 0 ? 'KeyW' : 'KeyS' }
    : { x: outward > 0 ? interior.x + interior.w + 55 : interior.x - 55, y: doorY, key: outward > 0 ? 'KeyA' : 'KeyD' };
  Object.assign(artPlayer, { x: approach.x, y: approach.y });
  await page.waitForFunction(id => window.arenaDebug().roofs.find(r => r.id === id)?.visible, interior.id);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/building-roof.png' });
  artPlayer.keys = 1;
  await page.keyboard.press('KeyE');
  await page.keyboard.down(approach.key); await page.waitForTimeout(850); await page.keyboard.up(approach.key);
  await page.waitForFunction(id => window.arenaDebug().roofs.find(r => r.id === id)?.visible === false, interior.id);
  assert.ok(artPlayer.x > interior.x && artPlayer.x < interior.x + interior.w && artPlayer.y > interior.y && artPlayer.y < interior.y + interior.h,
    'opened door and walked into a real building');
  await guest.close(); await mobile.close(); await visionPage.close(); await caster.close();
  // The deploy dialog lists open rooms (#254): a named room is listed to everyone, its Join usable, and a
  // server without a dev tools policy offers no dev view.
  const namedRoom = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":7,"name":"Night shift"}' })).json();
  await page.getByRole('button', { name: 'New arena', exact: true }).click();
  await page.getByRole('button', { name: 'Join Night shift', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Join Night shift', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Dev view of Night shift', exact: true }).count(), 0);
  await page.screenshot({ path: 'test-results/room-browser.png' });
  // Auto is matchmaking.
  await page.locator('#role-preference').selectOption('gladiator');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('lobby-dialog').open && window.arenaDebug().me?.role === 'gladiator');
  const matchedRoom = await page.evaluate(() => window.arenaDebug().room);
  assert.equal(server.rooms.get(matchedRoom).matchmade, true);
  assert.equal(await page.locator('#start-match').isVisible(), false);
  // The lobby lets a player change role and kit until the start (#235); the view under it follows.
  const choice = page.locator('#lobby-choice');
  assert.equal(await choice.locator('#lobby-kit').isVisible(), true, 'a gladiator sees their kit');
  // A kit picked in the lobby survives reselecting the role held and a spell as a contestant (#264 review);
  // the deploy dialog holds another kit, which neither may send.
  assert.notEqual(await page.locator('#kit').inputValue(), 'specter');
  await choice.locator('#lobby-kit').selectOption('specter');
  await page.waitForFunction(() => window.arenaDebug().me?.kit === 'specter');
  await choice.getByRole('button', { name: 'Gladiator', exact: true }).click();
  await choice.getByRole('button', { name: 'Contestant', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().me?.role === 'contestant' && document.getElementById('lobby-kit').hidden);
  await choice.getByRole('button', { name: 'Gladiator', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().me?.role === 'gladiator');
  assert.equal(await page.evaluate(() => window.arenaDebug().me.kit), 'specter');
  assert.equal(await choice.locator('#lobby-kit').inputValue(), 'specter');
  await page.screenshot({ path: 'test-results/lobby-choice.png' });
  server.rooms.get(matchedRoom).startsAt = Date.now() - 1;
  await page.waitForFunction(() => !document.getElementById('lobby-dialog').open && window.arenaDebug().phase === 'live' && window.arenaDebug().tick > 3);
  // A building's floor must sit under its walls: tiles replay drawings in the order recorded, and a floor
  // recorded after the obstacles once painted over every interior wall (#207), leaving the doors floating.
  const wallRoom = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":7}' })).json();
  await server.rooms.get(wallRoom.id).ready;
  const wallGame = server.rooms.get(wallRoom.id).game;
  const inside = b => wallGame.map.obstacles.filter(o => !o.points && o.kind === 'building' && o.x >= b.x + 20 && o.x < b.x + b.w - 20 && o.y >= b.y + 20 && o.y < b.y + b.h - 20);
  const walled = wallGame.map.buildings.find(b => b.w < 700 && inside(b).length > 2);
  assert.ok(walled, 'a seeded live map has a building with interior walls');
  const wallPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await ready(wallPage, `${base}/?room=${wallRoom.id}&ownerKey=${encodeURIComponent(wallRoom.ownerKey)}`);
  const wallBox = inside(walled).find(o => o.w >= 8 && o.h >= 24);
  Object.assign(wallGame.players.find(p => p.id === wallRoom.playerId) || wallGame.players[0], { x: walled.x + walled.w / 2, y: walled.y + walled.h / 2 });
  await wallPage.waitForTimeout(1500);
  const wallPixels = await wallPage.evaluate(box => {
    const d = window.arenaDebug(), canvas = document.querySelector('#game canvas'), gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    const sample = (x, y) => { const px = Math.round((x - d.camera.x) * d.camera.zoom), py = Math.round((y - d.camera.y) * d.camera.zoom); const rgba = new Uint8Array(4); gl.readPixels(px, gl.drawingBufferHeight - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); return [...rgba].slice(0, 3); };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, across = box.h > box.w ? [30, 0] : [0, 30];
    return { wall: sample(cx, cy), before: sample(cx - across[0], cy - across[1]), after: sample(cx + across[0], cy + across[1]) };
  }, wallBox);
  assert.ok(String(wallPixels.wall) !== String(wallPixels.before) && String(wallPixels.wall) !== String(wallPixels.after), `an interior wall is drawn over its building's floor: ${JSON.stringify({ wallBox, wallPixels })}`);
  // A page that has played one arena deploys another whose map cannot be generated (#258): the lobby it
  // was admitted to is gone, so it returns to the deploy dialog, not the last arena's frame.
  holdNextGeneration = true;
  await wallPage.getByRole('button', { name: 'New arena', exact: true }).click();
  await wallPage.getByRole('button', { name: 'Deploy', exact: true }).click();
  await wallPage.waitForFunction(() => document.getElementById('lobby-dialog').open && /Generating/.test(document.getElementById('lobby-waiting').textContent));
  failHeldGeneration();
  // The error text is set whatever the page then does with it, so wait for that before asking what is open.
  await wallPage.waitForFunction(() => !document.getElementById('deploy-error').hidden && /could not be generated/.test(document.getElementById('deploy-error').textContent));
  assert.deepEqual(await wallPage.evaluate(() => ({ deploy: document.getElementById('loadout-dialog').open, lobby: document.getElementById('lobby-dialog').open })), { deploy: true, lobby: false });
  assert.equal(await wallPage.evaluate(() => window.arenaDebug().tick), undefined, 'the previous arena is not shown as this one');
  // Back in the deploy dialog, Join enters a listed room's lobby, which shows its name.
  await wallPage.getByRole('button', { name: 'Join Night shift', exact: true }).click();
  await wallPage.waitForFunction(id => document.getElementById('lobby-dialog').open && window.arenaDebug().room === id
    && document.getElementById('lobby-title').textContent === 'Night shift', namedRoom.id);
  await wallPage.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, pixels, occlusion, screenshots: ['desktop', 'arena-overview', 'replay', 'loadout', 'gladiator', 'mobile', 'mobile-loadout', 'room-browser', 'waiting-yard', 'lobby-choice', 'occlusion', 'spectator'], checks: ['movement', 'ability', 'multiplayer', 'replay seek', 'download', 'kit selection', 'dual-stick multitouch', 'mouse aim', 'occlusion pixels', 'shade not blackout', 'client-side visibility', 'shot interpolation', 'spectator directed view', 'mobile overflow', 'generation failure after an arena', 'room browser join', 'waiting yard', 'lobby role and kit', 'assets', 'browser errors'] }, null, 2));
} catch (error) { console.error('Browser errors:', errors); throw error; }
finally { await browser.close(); await server.close(); await maps.close(); }
