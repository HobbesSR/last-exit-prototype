// The dev view (#231) on its own: a player's tab, the dev tab it opens, and what the dev tab can do to
// the room. Separate from browser.mjs so it can be iterated on in seconds rather than minutes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { canOccupy } from '../shared/movement.ts';

const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-dev-view-'));
await mkdir('test-results', { recursive: true });
const { server, base, browser } = await serveWithBrowser({ replayDir, profileSummary: false, devTools: 'all' });
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
  await page.waitForFunction(() => window.arenaDebug?.().phase === 'live' && window.arenaDebug().tick > 3);
  const { room: roomId, me } = await page.evaluate(() => window.arenaDebug());
  const room = server.rooms.get(roomId), subject = me.id;

  // A player steps out to the dev view in place (#246): their socket and slot stay, input stops, and
  // the view is the undelayed directed one. Stepping back returns to their own fogged view.
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().directed && window.arenaDebug().cameraWidth >= window.arenaDebug().mapWidth);
  const stepped = await page.evaluate(() => ({ ...window.arenaDebug(), hud: document.getElementById('live-hud').hidden }));
  assert.equal(stepped.vision, null); assert.equal(stepped.hud, true);
  // Following someone else in their sight: the stepped-out player is just another actor to them.
  const body = room.game.players.find(p => p.id === subject);
  const far = room.game.players.filter(p => p.bot && p.status === 'active').sort((a, b) => Math.hypot(b.x - body.x, b.y - body.y) - Math.hypot(a.x - body.x, a.y - body.y))[0];
  await page.locator('#dev-focus').selectOption(far.id);
  await page.waitForFunction(({ far, subject }) => window.arenaDebug().viewer === far && window.arenaDebug().vision
    && window.arenaDebug().actors.find(a => a.id === subject)?.visible === false, { far: far.id, subject });
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.arenaDebug().fog === false && window.arenaDebug().viewer === null && window.arenaDebug().vision === null);
  assert.ok(room.match.roster().some(p => p.id === subject), 'stepping out keeps the slot');
  const seqOf = () => room.match.snapshot().players.find(p => p.id === subject).lastSeq;
  await page.waitForTimeout(300); const parked = seqOf();
  await page.keyboard.down('KeyD'); await page.waitForTimeout(400); await page.keyboard.up('KeyD');
  assert.equal(seqOf(), parked, 'no input reaches the player while in the dev view');
  await page.locator('#dev-focus').selectOption(far.id);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && !window.arenaDebug().directed && window.arenaDebug().vision);
  await until(() => seqOf() > parked + 3, () => `input resumes after stepping back: ${seqOf()} vs ${parked}`);
  assert.equal(room.spectators, 0, 'the dev socket closed');
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(id => window.arenaDebug().devFeed && window.arenaDebug().follow === id && window.arenaDebug().fog === false, far.id);
  assert.equal(await page.evaluate(() => window.arenaDebug().viewer), null, 'stepping back out keeps the same view preference');
  await page.keyboard.press('KeyV');
  await page.waitForFunction(id => window.arenaDebug().viewer === id && window.arenaDebug().vision, far.id);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.arenaDebug().follow === null);
  const freeCamera = await page.evaluate(() => window.arenaDebug().camera);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().vision);
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(camera => {
    const d = window.arenaDebug();
    return d.devFeed && d.follow === null && d.vision === null && Math.abs(d.camera.x - camera.x) < 1
      && Math.abs(d.camera.y - camera.y) < 1 && Math.abs(d.camera.zoom - camera.zoom) < 0.001;
  }, freeCamera);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().vision);

  // Archive loads settle in whatever order the network chooses, so the page holds them here and the
  // check settles each one when it wants (#387). The archive lists two recordings of this room's
  // present frame, told apart by how far past it they declare they run; each is listed as an arena
  // named for that.
  const frame = room.match.snapshot();
  const recording = extra => ({ id: `held-${extra}`, hz: 20, map: room.match.spectatorMap(frame),
    frames: [{ state: room.match.project(frame, null), commands: [] }], recording: { complete: true, droppedFrames: 0, endTick: frame.tick + extra } });
  await page.evaluate(({ recordings, rows }) => {
    const held = window.heldReplays = {}, realFetch = window.realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (url === '/api/replays') return Promise.resolve({ ok: true, json: async () => rows });
      const id = /^\/api\/replays\/(.+)$/.exec(url)?.[1];
      if (!recordings[id]) return realFetch(url, options);
      return new Promise(resolve => {
        held[id] = error => resolve(error ? { ok: false, json: async () => ({ error }) } : { ok: true, json: async () => recordings[id] });
      });
    };
  }, { recordings: Object.fromEntries([7, 9].map(n => [`held-${n}`, recording(n)])),
    rows: [7, 9].map(n => ({ id: `held-${n}`, seed: n, ticks: n, escaped: 0, createdAt: Date.now() })) });
  const choose = async length => {
    if (!await page.evaluate(() => document.getElementById('archive-dialog').open)) await page.getByRole('button', { name: 'Replays', exact: true }).click();
    await page.getByRole('button', { name: `Play arena ${length}`, exact: true }).click();
    await page.waitForFunction(id => window.heldReplays[id], `held-${length}`);
  };
  // Settling runs the load to its end: what follows the response is all microtasks, done before a timer.
  const settle = (length, error = null) => page.evaluate(([id, error]) => {
    const release = window.heldReplays[id]; delete window.heldReplays[id]; release(error);
    return new Promise(resolve => setTimeout(resolve));
  }, [`held-${length}`, error]);
  const shown = () => page.evaluate(start => window.arenaDebug().replay ? Number(document.getElementById('replay-seek').max) - start : null, frame.tick);
  const closeArchive = () => page.locator('#archive-dialog .close-dialog').click();
  const toastText = () => page.locator('#toast').textContent();
  // The latest choice wins whichever answers first, and a superseded failure says nothing.
  await choose(7); await choose(9);
  await settle(9); assert.equal(await shown(), 9, 'the latest choice opens');
  await settle(7); assert.equal(await shown(), 9, 'an earlier choice answering late does not replace it');
  await choose(7); await choose(9);
  await settle(7, 'superseded failure'); await settle(9);
  assert.equal(await shown(), 9);
  assert.notEqual(await toastText(), 'superseded failure', 'a superseded failure raises no toast');
  await choose(7); await settle(7, 'current failure');
  assert.equal(await toastText(), 'current failure', 'the current load still reports its own failure');
  assert.equal(await shown(), 9, 'and leaves the open replay as it was');
  // Leaving the replay, or stepping out to the dev view, abandons a load still in flight.
  await choose(7); await closeArchive();
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await settle(7); assert.equal(await shown(), null, 'closing the replay abandons a pending load');
  await choose(7); await closeArchive();
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed);
  await settle(7); assert.equal(await shown(), null, 'stepping out to the dev view abandons a pending load');
  assert.equal(await page.evaluate(() => window.arenaDebug().view), 'dev');

  // The live socket's frame gaps are the network's, measured whatever is drawn (#387). The dev feed's
  // frames must not stand in for the player socket's: withholding the player's frames for a second
  // while the dev feed carries on is a second-long gap.
  const gaps = () => page.evaluate(() => window.arenaProfile().series.find(row => row.name === 'net.stateGap') ?? { calls: 0, mean: 0, max: 0 });
  const profileAfresh = () => page.evaluate(() => { window.arenaProfiling(false); window.arenaProfiling(true); });
  const session = [...room.clients].find(client => client.playerId === subject), deliver = session.deliver;
  await profileAfresh();
  session.deliver = (payload, droppable) => droppable ? false : deliver(payload, droppable);
  await new Promise(resolve => setTimeout(resolve, 1000));
  session.deliver = deliver;
  await page.waitForFunction(() => window.arenaProfile().series.find(row => row.name === 'net.stateGap')?.calls >= 5);
  const withheld = await gaps();
  assert.ok(withheld.max >= 800, `a withheld second is measured on the live socket in the dev view: ${JSON.stringify(withheld)}`);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().vision);
  // Behind a replay the live socket keeps its ordinary interval, rather than measuring from the last
  // frame drawn before the replay opened.
  await profileAfresh();
  await choose(9); await settle(9);
  await page.waitForFunction(() => window.arenaProfile().series.find(row => row.name === 'net.stateGap')?.calls >= 20, null, { timeout: 10000 });
  const behind = await gaps();
  assert.ok(behind.mean < 150, `live frames behind a replay keep the 50 ms server interval: ${JSON.stringify(behind)}`);
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.evaluate(() => window.arenaProfiling(false));

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
  // The followed player sees themselves even cloaked, as in their own view.
  room.game.players.find(p => p.id === subject).cloak = 200;
  await dev.waitForTimeout(400);
  assert.equal(await dev.evaluate(id => window.arenaDebug().actors.find(a => a.id === id).visible, subject), true, 'a cloaked followed player stays visible');
  room.game.players.find(p => p.id === subject).cloak = 0;
  assert.ok(Math.abs(followed.debug.camera.x + followed.debug.cameraWidth / 2 - followed.subject.x) < 60, 'following centres on the subject');
  await dev.keyboard.press('KeyV');
  await dev.waitForFunction(() => window.arenaDebug().viewer === null && window.arenaDebug().vision === null && window.arenaDebug().follow);
  // T sends the followed player to the open ground under the cursor (#247).
  const view = await dev.evaluate(() => { const box = document.querySelector('#game canvas').getBoundingClientRect(); return { ...window.arenaDebug(), left: box.left, top: box.top }; });
  const before = room.game.players.find(p => p.id === subject);
  const spot = [[300, 0], [-300, 0], [0, 250], [0, -250], [250, 200], [-250, -200]].map(([dx, dy]) => ({ x: Math.round(before.x + dx), y: Math.round(before.y + dy) }))
    .find(point => canOccupy(room.game.map, point.x, point.y, 12));
  assert.ok(spot, 'there is open ground near the subject');
  await dev.mouse.move(view.left + (spot.x - view.camera.x) * view.camera.zoom, view.top + (spot.y - view.camera.y) * view.camera.zoom);
  await dev.keyboard.press('KeyT');
  await until(() => Math.hypot(before.x - spot.x, before.y - spot.y) < 3, () => `the subject was teleported to ${JSON.stringify(spot)}: at ${before.x},${before.y}`);
  await dev.waitForFunction(() => document.getElementById('toast').textContent.endsWith('moved'));
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

  // The lobby browser (#254) offers a dev view of a listed room under this policy. The role Join uses
  // is the dialog's own choice: entering a dev view, or Auto with no preference, must not replace it.
  const named = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":9,"name":"Night shift"}' })).json();
  const browse = async () => {
    await page.getByRole('button', { name: 'Lobbies', exact: true }).click();
    const join = page.getByRole('button', { name: 'Join Night shift', exact: true });
    await join.waitFor();
    // Wait out a refresh, so the row is drawn after whatever the last connection did.
    const drawn = await join.elementHandle(); await page.waitForFunction(old => !old.isConnected, drawn);
    assert.equal(await join.isEnabled(), true, 'Join stays usable for the role the dialog shows');
    assert.equal(await page.locator('[data-role][aria-pressed="true"]').getAttribute('data-role'), 'contestant');
  };
  // Moving to another room abandons a replay load begun in this one.
  await page.getByRole('button', { name: 'Dev view', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug().devFeed);
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.arenaDebug().fog === false);
  await page.keyboard.press('Backquote');
  await page.waitForFunction(() => !window.arenaDebug().devFeed);
  await choose(7); await closeArchive();
  await browse();
  await page.getByRole('button', { name: 'Dev view of Night shift', exact: true }).click();
  await page.waitForFunction(id => window.arenaDebug().dev && window.arenaDebug().room === id, named.id);
  assert.equal(await page.evaluate(() => window.arenaDebug().fog), true, 'connecting to a different room restores fog in the same page');
  await settle(7); assert.equal(await shown(), null, 'a room transition abandons a pending load');
  await page.evaluate(() => { window.fetch = window.realFetch; });
  await browse();
  await page.locator('#role-preference').selectOption('any');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('lobby-dialog').open && window.arenaDebug().me);
  // Stepped out to the dev view from the lobby (it is not modal, #236), the start must not lay the player's
  // own HUD over the directed view, and stepping back shows it (#267 review).
  const hud = () => page.evaluate(() => document.getElementById('live-hud').hidden);
  await page.locator('#dev-view').click();
  await page.waitForFunction(() => window.arenaDebug().devFeed);
  assert.equal(await hud(), true, 'no player HUD in the lobby');
  server.rooms.get(await page.evaluate(() => window.arenaDebug().room)).startsAt = Date.now() - 1;
  await page.waitForFunction(() => !document.getElementById('lobby-dialog').open && window.arenaDebug().devFeed && window.arenaDebug().phase === 'live' && window.arenaDebug().tick > 3);
  assert.equal(await hud(), true, 'the start keeps it hidden under the dev view');
  assert.equal(await page.locator('#connection-text').textContent(), 'DEV VIEW');
  await page.locator('#dev-view').click();
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().phase === 'live');
  assert.equal(await hud(), false, 'stepping back shows it');

  // When a player is eliminated, the death dialog shows (#277). Stepping out to the dev view
  // must hide the death dialog, and stepping back must restore it.
  const currentRoom = server.rooms.get(await page.evaluate(() => window.arenaDebug().room));
  const currentMe = await page.evaluate(() => window.arenaDebug().me);
  currentRoom.game.players.find(p => p.id === currentMe.id).status = 'eliminated';
  await page.waitForFunction(() => !document.getElementById('outcome').hidden && window.arenaDebug().view === 'outcome');
  assert.equal(await page.locator('#outcome-label').textContent(), 'CONTESTANT ELIMINATED');
  assert.equal(await page.locator('#outcome-title').textContent(), 'End of the line.');

  // Step out to dev view while dead: outcome dialogue must be hidden
  await page.locator('#dev-view').click();
  await page.waitForFunction(() => window.arenaDebug().devFeed && window.arenaDebug().view === 'dev');
  assert.equal(await page.evaluate(() => document.getElementById('outcome').hidden), true, 'death dialogue is hidden in dev view');
  assert.equal(await page.locator('#dev-leave').textContent(), 'Back to results', 'leave button reflects results view');

  // Step back to death screen: outcome dialogue must be restored
  await page.locator('#dev-leave').click();
  await page.waitForFunction(() => !window.arenaDebug().devFeed && window.arenaDebug().view === 'outcome');
  assert.equal(await page.evaluate(() => document.getElementById('outcome').hidden), false, 'death dialogue is restored when stepping back');

  // Open archive/replay dialog and closing it restores death screen
  await page.locator('#archive').click();
  await page.waitForFunction(() => document.getElementById('archive-dialog').open);
  await page.locator('#archive-dialog .close-dialog').click();
  await page.waitForFunction(() => !document.getElementById('archive-dialog').open && window.arenaDebug().view === 'outcome');
  assert.equal(await page.evaluate(() => document.getElementById('outcome').hidden), false, 'death dialogue remains visible after closing archive dialog');

  await browse();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['step out and back', 'dev view opens undelayed', 'free camera', 'follow in sight', 'fog toggle', 'teleport', 'pause and resume', 'browser dev view', 'browser role after dev view and Auto', 'dev view across the start', 'death dialog hidden in dev view and restored'] }));
} catch (error) { console.error('Browser errors:', errors); throw error; }
finally { await browser.close(); await server.close(); await rm(replayDir, { recursive: true, force: true }); }
