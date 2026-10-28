import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArenaServer } from '../server/index.js';
import { createMapGenerator } from '../server/map-generator.js';
import { listen } from './helpers/listen.js';
import { createGame, snapshot, VERSION } from '../shared/simulation.ts';
import { legacyContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import { SCHEMA, minimumReaderForMap } from '../shared/recording.ts';

// Two content sets this browser does not ship, sharing weapon and kit ids but labelled differently (22.7). They start from
// the legacy set: this check is about display data, and the shipped default is physics content (#523).
// B is what the live server runs; A is what a recording embeds.
function contentB() {
  const c = structuredClone(legacyContent());
  c.id = 'browser-content-b';
  c.weapons.pistol.name = 'Sidearm'; c.weapons.pistol.ammo = 7; c.weapons.rifle.name = 'Carbine'; c.weapons.rifle.ammo = 21;
  c.kits.warden.name = 'Guard'; c.kits.warden.skill = 'Stomp'; c.kits.specter.name = 'Shade'; c.kits.specter.skill = 'Flicker';
  delete c.kits.striker;
  c.roster.contestants = ['Ada', 'Bo', 'Cy'];
  c.roster.gladiators = [{ name: 'ONE', kit: 'warden' }, { name: 'TWO', kit: 'specter' }];
  c.durationTicks = 3000; c.cellChargeTicks = 60;
  return c;
}
function contentA() {
  const c = structuredClone(legacyContent());
  c.id = 'browser-content-a';
  c.weapons.pistol.name = 'Blaster'; c.weapons.pistol.ammo = 11; c.weapons.rifle.name = 'Longarm'; c.weapons.rifle.ammo = 33;
  c.kits.warden.name = 'Sentinel'; c.kits.warden.skill = 'Quake'; c.kits.specter.name = 'Wraith'; c.kits.specter.skill = 'Echo';
  c.durationTicks = 9000;
  return c;
}
// A recording of content A whose frames state their own duration, which must beat A's descriptor.
function recordingA() {
  const content = contentA(), game = createGame(4217, undefined, content), p = game.players[0];
  p.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 0 }, { kind: 'weapon', weaponType: 'rifle' }, null, null, null, null];
  p.selectedSlot = 0;
  const frame = tick => { const state = snapshot(game); state.tick = tick; state.duration = 6000; return { state, commands: [] }; };
  return { version: VERSION, schema: SCHEMA, minSchema: minimumReaderForMap(game.map), contentId: content.id, presentation: describeContent(content),
    id: 'content-a', seed: 777, hz: 20, createdAt: Date.now(), map: game.map, frames: [0, 20, 40].map(frame),
    recording: { complete: true, droppedFrames: 0, endTick: 40 } };
}
const texts = (page, selector) => page.$$eval(selector, nodes => nodes.map(n => n.textContent));

/** Isolated HUD and vocabulary inputs: explicit, replaced and unknown descriptors, and frame authority. */
async function checkControls(browser, base) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const html = (await readFile('public/index.html', 'utf8')).replace('<script type="module" src="/client.js"></script>', '');
  await page.route('**/content-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
  const game = createGame(4217), me = game.players[0], hunter = game.players.find(p => p.role === 'gladiator');
  me.inventory = [{ kind: 'weapon', weaponType: 'pistol' }, { kind: 'weapon', weaponType: 'rifle', ammo: 0 }, { kind: 'cell', charge: 30 }, null, null, null];
  game.map.gates = [];
  try {
    await page.goto(`${base}/content-fixture`);
    const result = await page.evaluate(async ({ state, arenaMap, hunterId, a, b }) => {
      const { createHUDController } = await import('/hud-controller.js');
      const { fillKitOptions, fillFollowOptions } = await import('/ui.js');
      const $ = id => document.getElementById(id), noop = () => {};
      const hud = createHUDController({ selectSlot: noop, arrange: noop, skill: noop, interact: noop, drop: noop, moveSlot: noop, dropSlot: noop, cancelPointerFire: noop, canDrag: () => false, toggleFullscreen: noop });
      const base = { state, arenaMap, playerId: state.players[0].id, view: 'play', savedReplay: null, selection: { moveFrom: null }, visibility: { directed: true } };
      const slots = () => [...$('equipment-slots').children].slice(0, 3).map(b => [b.ariaLabel, b.title]);
      const read = () => ({ slots: slots(), clock: $('clock').textContent, objective: $('objective').textContent });
      hud.render({ ...base, presentation: a }); const first = read();
      // The same ids and counts under another descriptor: only the labels differ.
      hud.render({ ...base, presentation: b }); const replaced = read();
      const bare = { ...state, duration: undefined, cellChargeTicks: undefined };
      hud.render({ ...base, state: bare, presentation: null }); const unknown = read();
      hud.render({ ...base, state: { ...state, cellChargeTicks: undefined }, presentation: null }); const unknownTimed = read();
      hud.render({ ...base, state: bare, presentation: a }); const fallback = read();
      // An archive from before content ids and inventories: a dedicated cell, timed by the legacy profile.
      const { resolveRecordingPresentation } = await import('/shared/presentation.ts');
      const legacyState = { ...bare, players: [{ ...state.players[0], inventory: undefined, cell: { charge: 50 } }, ...state.players.slice(1)] };
      hud.render({ ...base, state: legacyState, view: 'replay', presentation: resolveRecordingPresentation({ schema: 1 }).presentation }); const legacy = read();
      const gladiator = { ...base, playerId: hunterId };
      hud.render({ ...gladiator, presentation: a }); const kitA = [$('player-name').textContent, $('skill').dataset.tip];
      hud.render({ ...gladiator, presentation: null }); const kitUnknown = [$('player-name').textContent, $('skill').dataset.tip];
      hud.destroy();
      // Kit options never send anything and fall back to the default, then the first, then nothing.
      const select = document.createElement('select'); let events = 0;
      select.addEventListener('change', () => events++); select.addEventListener('input', () => events++);
      const kits = list => ({ ...a, kits: list });
      const kept = [fillKitOptions(select, a, 'specter'), [...select.options].map(o => o.textContent)];
      const withoutStriker = fillKitOptions(select, kits(a.kits.filter(k => k.id !== 'striker')), 'striker');
      const withoutWarden = fillKitOptions(select, kits(a.kits.filter(k => k.id !== 'warden')), 'gone');
      const none = [fillKitOptions(select, kits([]), 'warden'), select.disabled];
      const follow = document.createElement('select'), roster = [{ id: 'g', name: 'Hunter', role: 'gladiator', kit: 'specter' }];
      fillFollowOptions(follow, roster, a); const followA = follow.options[1].textContent;
      fillFollowOptions(follow, roster, null); const followUnknown = follow.options[1].textContent;
      fillFollowOptions(follow, roster); const followShipped = follow.options[1].textContent;
      return { first, replaced, unknown, unknownTimed, fallback, legacy, kitA, kitUnknown, kept, withoutStriker, withoutWarden, none, events, followA, followUnknown, followShipped };
    }, { state: snapshot(game), arenaMap: game.map, hunterId: hunter.id, a: describeContent(contentA()), b: describeContent(contentB()) });
    assert.deepEqual(result.first.slots, [['Slot 1: Blaster 11', 'Blaster · 11 rounds'], ['Slot 2: Longarm 0', 'Longarm · 0 rounds'], ['Slot 3: Power cell 30%', 'Power cell']], 'descriptor ammo fills in; recorded zero stays zero');
    assert.deepEqual(result.replaced.slots, [['Slot 1: Sidearm 7', 'Sidearm · 7 rounds'], ['Slot 2: Carbine 0', 'Carbine · 0 rounds'], ['Slot 3: Power cell 30%', 'Power cell']], 'labels follow a replaced descriptor');
    assert.equal(result.first.clock, result.replaced.clock, 'the frame duration beats both descriptors');
    assert.equal(result.first.clock, '10:00');
    assert.deepEqual(result.unknown.slots, [['Slot 1: pistol —', 'pistol · — rounds'], ['Slot 2: rifle 0', 'rifle · 0 rounds'], ['Slot 3: Power cell —', 'Power cell']], 'unknown content shows raw ids and guesses nothing');
    assert.equal(result.unknown.clock, '—');
    assert.match(result.unknown.objective, /CELL — /);
    assert.equal(result.unknownTimed.clock, '10:00', 'unknown content still shows a recorded clock');
    assert.equal(result.fallback.clock, '07:30', 'a frame without a duration uses the descriptor');
    assert.match(result.fallback.objective, /CELL 30%/, '30 of A\'s 100 charge ticks');
    assert.match(result.legacy.objective, /CELL 50%/, 'legacy dedicated cell over the 100-tick legacy charge');
    assert.equal(result.legacy.clock, '02:00', 'and the legacy 2400-tick clock');
    assert.deepEqual(result.kitA, ['SENTINEL', 'Quake (Q)']);
    assert.deepEqual(result.kitUnknown, ['WARDEN', '— (Q)']);
    assert.deepEqual(result.kept, ['specter', ['Sentinel / Quake', 'Wraith / Echo', 'Striker / Overdrive']]);
    assert.equal(result.withoutStriker, 'warden');
    assert.equal(result.withoutWarden, 'specter');
    assert.deepEqual(result.none, ['', true]);
    assert.equal(result.events, 0, 'rebuilding kit options chooses nothing');
    assert.deepEqual([result.followA, result.followUnknown, result.followShipped], ['Hunter / Wraith', 'Hunter / specter', 'Hunter / Specter']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

/**
 * The application: configuration that fails and recovers without touching the room, live content B
 * labels, a recording of content A shown over it, a live update arriving behind that recording, the
 * restore to live, and the dev view of a room whose map is still being generated.
 */
export async function checkContentPresentation(browser) {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'content-presentation-'));
  const maps = createMapGenerator();
  let holdNext = false, release = null;
  const generateMap = (seed, size) => {
    if (!holdNext) return maps.generate(seed, size);
    holdNext = false;
    return new Promise(resolve => { release = () => resolve(maps.generate(seed, size)); });
  };
  const server = await createArenaServer({ replayDir, content: contentB, devTools: 'all', generateMap });
  const base = await listen(server);
  const errors = [], pages = [];
  // Each page may expect the refusals it arranges; any other console error fails the check.
  const open = async (expected = /status of 503/) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.push(page);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !expected.test(m.text())) errors.push(m.text()); });
    return page;
  };
  try {
    await checkControls(browser, base);
    // A live welcome must carry a descriptor naming its own content id; otherwise nothing of it is installed.
    for (const [contentId, presentation] of [['browser-content-b', undefined], ['browser-content-b', describeContent(contentA())], ['', describeContent(contentB())]]) {
      const page = await open(/status of 503/);
      await page.routeWebSocket(/.*/, ws => ws.onMessage(message => {
        if (JSON.parse(message).type !== 'join') return;
        ws.send(JSON.stringify({ type: 'welcome', id: 'p0', room: 'forged', owner: false, ready: true, started: true, contentId, presentation,
          map: { width: 777, height: 100, obstacles: [], gates: [], items: [], modules: [] }, state: { tick: 1, phase: 'live', players: [] } }));
      }));
      await page.goto(`${base}/?room=forged`);
      await page.waitForFunction(() => document.getElementById('connection-text').textContent === 'UNAVAILABLE');
      assert.deepEqual(await page.evaluate(() => [window.arenaDebug().mapWidth, window.arenaDebug().content, window.arenaDebug().tick]), [undefined, null, undefined], `refused ${contentId} ${presentation?.contentId}`);
      await page.close();
    }
    const owner = await open(), posts = [];
    owner.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/rooms') posts.push(r.postDataJSON()); });
    let failConfig = true;
    await owner.route('**/api/client-config', async route => {
      if (!failConfig) return route.continue();
      await new Promise(resolve => setTimeout(resolve, 300));
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    });
    await owner.goto(`${base}/?seed=4217`);
    // The first visit's room is created and admitted while configuration is failing.
    await owner.waitForFunction(() => document.getElementById('lobby-dialog').open && window.arenaDebug().me?.id, null, { timeout: 120000 });
    await owner.waitForFunction(() => !document.getElementById('config-error').hidden);
    assert.deepEqual(posts, [{ seed: '4217' }], 'one automatic room, naming only the address\'s seed');
    const roomId = await owner.evaluate(() => window.arenaDebug().room), ownerId = await owner.evaluate(() => window.arenaDebug().me.id);
    assert.deepEqual(await owner.evaluate(() => ({
      auto: document.getElementById('auto-match').disabled, deploy: document.querySelector('#deploy-form .deploy').disabled,
      kit: document.getElementById('kit').disabled, size: document.getElementById('map-size').disabled,
    })), { auto: true, deploy: true, kit: true, size: true }, 'form creation and matchmaking wait for configuration');
    assert.deepEqual(await texts(owner, '#kit option'), ['Loading kits…']);
    await owner.waitForFunction(() => document.getElementById('lobby-count').textContent === '1/3 contestants / 0/2 gladiators');
    assert.deepEqual(await texts(owner, '#lobby-contestants strong'), ['Runner'], 'the default callsign, not a placeholder read');
    assert.equal(await owner.evaluate(() => window.arenaDebug().content), 'browser-content-b');

    // The room's own kits, in its lobby.
    await owner.locator('[data-lobby-role="gladiator"]').click();
    await owner.waitForFunction(() => !document.getElementById('lobby-kit').hidden && document.getElementById('lobby-gladiators').textContent.includes('Guard'));
    assert.deepEqual(await texts(owner, '#lobby-kit option'), ['Guard / Stomp', 'Shade / Flicker']);
    assert.equal(await owner.locator('#lobby-kit').inputValue(), 'warden');

    // A retry loads the options and changes nothing about the room or the player in it.
    failConfig = false;
    await owner.evaluate(() => document.getElementById('config-retry').click());
    await owner.waitForFunction(() => !document.getElementById('kit').disabled);
    assert.deepEqual(await texts(owner, '#kit option'), ['Guard / Stomp', 'Shade / Flicker']);
    assert.deepEqual(await owner.$$eval('#map-size option', nodes => nodes.map(n => n.value)), ['12x6', '24x12', '36x18']);
    assert.deepEqual(await owner.evaluate(() => ({
      size: document.getElementById('map-size').value, seed: document.getElementById('seed').value, seedMax: document.getElementById('seed').max,
      callsign: document.getElementById('callsign').maxLength, roomNameLimit: document.getElementById('room-name').hasAttribute('maxlength'),
      help: document.getElementById('room-name-limit').textContent, countdown: document.getElementById('matchmaking-countdown').textContent,
      auto: document.getElementById('auto-match').disabled, error: document.getElementById('config-error').hidden,
    })), { size: '12x6', seed: '4217', seedMax: '2147483647', callsign: 16, roomNameLimit: false, help: 'At most 24 characters.', countdown: '15 seconds', auto: false, error: true });
    assert.equal(posts.length, 1, 'no second room');
    assert.deepEqual(await owner.evaluate(() => [window.arenaDebug().room, window.arenaDebug().me.id]), [roomId, ownerId], 'membership kept');
    assert.deepEqual(await texts(owner, '#lobby-kit option'), ['Guard / Stomp', 'Shade / Flicker'], 'the deploy form does not relabel the room');

    // An address naming a size the server does not author goes to it as given, and stays named in the form.
    const sized = await open(/status of 400/), sizedPosts = [];
    sized.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/rooms') sizedPosts.push(r.postDataJSON()); });
    await sized.goto(`${base}/?size=99x99`);
    await sized.waitForFunction(() => /Size must be one of/.test(document.getElementById('deploy-error').textContent) && !document.getElementById('map-size').disabled);
    assert.deepEqual(sizedPosts, [{ size: '99x99' }]);
    assert.equal(await sized.locator('#map-size').inputValue(), '99x99', 'never silently another size');

    // A dev view of a room still generating its map: the welcome carries B's descriptor without a map.
    holdNext = true;
    const pending = await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":99}' })).json();
    const dev = await open();
    await dev.goto(`${base}/?room=${pending.id}&dev`);
    await dev.waitForFunction(() => window.arenaDebug().content === 'browser-content-b' && document.getElementById('connection-text').textContent === 'DEV VIEW');
    assert.equal(await dev.evaluate(() => window.arenaDebug().mapWidth), undefined, 'no map yet');

    // Recording A over it, then the map and B's ready arrive behind the recording.
    await dev.route('**/api/replays', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'content-a', seed: 777, ticks: 40, escaped: 0, createdAt: Date.now() }]) }));
    const recording = JSON.stringify(recordingA());
    await dev.route('**/api/replays/content-a', route => route.fulfill({ contentType: 'application/json', body: recording }));
    await dev.getByRole('button', { name: 'Replays', exact: true }).click();
    await dev.getByRole('button', { name: 'Play arena 777', exact: true }).click();
    await dev.waitForFunction(() => window.arenaDebug().replay && window.arenaDebug().content === 'browser-content-a');
    await dev.evaluate(() => { const b = document.getElementById('replay-play'); if (b.ariaLabel === 'Pause replay') b.click(); });
    await dev.locator('#replay-seek').fill('0');
    const replayView = () => dev.evaluate(() => ({
      slots: [...document.getElementById('equipment-slots').children].slice(0, 2).map(b => [b.ariaLabel, b.title]),
      clock: document.getElementById('clock').textContent,
      follow: [...document.querySelectorAll('#replay-focus optgroup[label="Gladiators"] option')].map(o => o.textContent),
    }));
    const expectedReplay = { slots: [['Slot 1: Blaster 0', 'Blaster · 0 rounds'], ['Slot 2: Longarm 33', 'Longarm · 33 rounds']], clock: '05:00', follow: ['IRONCLAD / Sentinel', 'VESPER / Wraith', 'BLAZE / Striker'] };
    await dev.waitForFunction(() => document.getElementById('clock').textContent === '05:00');
    assert.deepEqual(await replayView(), expectedReplay, 'the recording\'s own labels, ammo and frame clock');
    release();
    // The room's map arrives, and with it a ready carrying B, while the recording is shown.
    for (let waited = 0; !(await (await fetch(`${base}/api/rooms`)).json()).find(r => r.id === pending.id)?.ready; waited += 100) {
      assert.ok(waited < 120000, 'the held map was generated'); await new Promise(resolve => setTimeout(resolve, 100));
    }
    await dev.waitForTimeout(1000);
    assert.equal(await dev.evaluate(() => window.arenaDebug().content), 'browser-content-a');
    assert.deepEqual(await replayView(), expectedReplay, 'a live update behind the recording leaves its labels');
    await dev.getByRole('button', { name: 'Exit replay' }).click();
    await dev.waitForFunction(() => !window.arenaDebug().replay && window.arenaDebug().content === 'browser-content-b' && window.arenaDebug().mapWidth > 0, null, { timeout: 120000 });
    await dev.waitForFunction(() => [...document.querySelectorAll('#dev-focus option')].some(o => o.textContent === 'ONE / Guard'));
    assert.deepEqual(await texts(dev, '#dev-focus optgroup[label="Gladiators"] option'), ['ONE / Guard', 'TWO / Shade'], 'restored to live, with live labels');

    // The owner's live match runs and labels content B.
    await owner.getByRole('button', { name: 'Start match', exact: true }).click();
    await owner.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().tick > 3, null, { timeout: 120000 });
    assert.deepEqual(await owner.evaluate(() => [document.getElementById('player-name').textContent, document.getElementById('skill').dataset.tip]), ['GUARD', 'Stomp (Q)']);
    assert.match(await owner.locator('#clock').textContent(), /^02:[0-2]\d$/, 'B\'s 3000-tick match');
    // Stepping out to the dev feed labels its roster from that feed's own descriptor.
    await owner.getByRole('button', { name: 'Dev view', exact: true }).click();
    await owner.waitForFunction(() => window.arenaDebug().devFeed && [...document.querySelectorAll('#dev-focus option')].some(o => o.textContent === 'Runner / Guard'));
    assert.equal(await owner.evaluate(() => window.arenaDebug().content), 'browser-content-b');
    assert.deepEqual(errors, []);
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await server.close(); await maps.close(); await rm(replayDir, { recursive: true, force: true });
  }
}
