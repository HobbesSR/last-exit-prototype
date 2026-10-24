// Physics presentation is drawn from a retained frame, without loading a physics engine.
import assert from 'node:assert/strict';
import { serveWithBrowser } from './helpers/browser.js';

const { server, base, browser } = await serveWithBrowser({ profileSummary: false });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/physics-playback-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<html><body style="margin:0"><script type="importmap">{"imports":{"sat":"/sat-browser.js"}}</script><script src="/vendor/sat/SAT.js"></script><script src="/vendor/phaser/phaser.min.js"></script></body></html>' }));
  await page.goto(`${base}/physics-playback-fixture`);
  await page.evaluate(async () => {
    const { makeArenaScene } = await import('/arena-scene.js');
    const map = { seed: 1, width: 5000, height: 3000, modules: [], hazards: [], gaps: [], stations: [], sensors: [], gates: [], routes: [], buildings: [], obstacles: [] };
    const player = { id: 'self', name: 'Viewer', role: 'contestant', x: 500, y: 400, heading: 0, status: 'active', hp: 100, maxHp: 100 };
    const near = (id, x, y, shape) => ({ id, kind: 'prop', x, y, angle: 0.5, vx: 0, vy: 0, omega: 0, sleeping: false, generation: 1, shape });
    const cloaked = { id: 'cloaked', name: 'Hidden', role: 'contestant', x: 575, y: 440, heading: 0, status: 'active', hp: 100, maxHp: 100, cloak: true };
    const state = { tick: 1, physicsProfile: 'test', players: [player, cloaked], gates: [], items: [{ id: 'med-1', kind: 'med', x: 700, y: 400 }], traps: [], projectiles: [], effects: [],
      bodies: [near('circle', 550, 400, { kind: 'circle', radius: 15 }), near('box', 600, 400, { kind: 'box', hx: 18, hy: 12 }),
        { ...near('med-body', 650, 400, { kind: 'circle', radius: 10 }), itemId: 'med-1' },
        { ...near('actor-body', 520, 400, { kind: 'circle', radius: 20 }), kind: 'actor', actorId: 'self' },
        { ...near('cloaked-body', 575, 440, { kind: 'circle', radius: 20 }), kind: 'actor', actorId: 'cloaked' },
        near('hidden', 4000, 2500, { kind: 'circle', radius: 30 })], tethers: [{ id: 'r1', a: 'circle', b: 'box' },
        { id: 'cloaked-rope', a: 'circle', b: 'cloaked-body' }, { id: 'hidden-rope', a: 'circle', b: 'hidden' }] };
    const api = { map: () => map, state: () => state, self: () => player, playerId: () => player.id, directed: () => false,
      follow: () => null, replay: () => true, onFrame() {}, onReady(scene) { window.scene = scene; }, onFire() {}, frameAlpha: () => 0, aim: () => 0 };
    window.fixture = { map, player, state };
    window.game = new Phaser.Game({ type: Phaser.WEBGL, width: 900, height: 700, audio: { noAudio: true }, scene: makeArenaScene(api) });
  });
  await page.waitForFunction(() => window.scene?.ready && window.scene.dynamic);
  const result = await page.evaluate(() => {
    const scene = window.scene, calls = [];
    for (const method of ['lineBetween', 'fillCircle', 'fillPoints', 'fillRect', 'fillRoundedRect']) {
      const original = scene.dynamic[method].bind(scene.dynamic);
      scene.dynamic[method] = (...args) => { calls.push([method, args]); return original(...args); };
    }
    scene.update(performance.now(), 16);
    return { calls, actorX: scene.actors.get('self').container.x,
      engineLoaded: performance.getEntriesByType('resource').some(entry => /rapier|physics-world/i.test(entry.name)) };
  });
  assert.ok(result.calls.some(([method, args]) => method === 'fillCircle' && args[0] === 550 && args[1] === 400), 'visible circle uses recorded pose');
  assert.ok(result.calls.some(([method, args]) => method === 'fillPoints' && args.length), 'rotated box uses recorded shape');
  assert.ok(result.calls.some(([method, args]) => method === 'lineBetween' && args[0] === 550 && args[2] === 600), 'authorized rope uses endpoint poses');
  assert.ok(!result.calls.some(([method, args]) => method === 'lineBetween' && args[0] === 550 && args[2] === 575), 'cloaked nearby actor does not reveal its tether');
  assert.equal(result.actorX, 520, 'actor art uses the authoritative body position');
  assert.ok(result.calls.some(([method, args]) => (method === 'fillRect' || method === 'fillRoundedRect') && args[0] >= 638 && args[0] <= 650 && args[1] >= 388 && args[1] <= 400), 'item art uses its linked body position');
  assert.ok(!result.calls.some(([, args]) => args.includes(4000) || args.includes(2500)), 'hidden body and rope are withheld');
  assert.equal(result.engineLoaded, false);
  const revealed = await page.evaluate(() => {
    window.fixture.player.role = 'gladiator';
    window.fixture.state.players[1].revealed = 1;
    const calls = [], graphics = window.scene.dynamic, original = graphics.lineBetween.bind(graphics);
    graphics.lineBetween = (...args) => { calls.push(args); return original(...args); };
    window.scene.update(performance.now(), 16);
    return calls;
  });
  assert.ok(revealed.some(args => args[0] === 550 && args[2] === 575), 'gladiator reveal permits the same cloaked actor tether');
  const cut = await page.evaluate(() => {
    const scene = window.scene, state = window.fixture.state;
    const ownBody = state.bodies.find(body => body.id === 'actor-body');
    ownBody.x = 600; ownBody.generation++;
    scene.update(performance.now(), 16);
    const first = { eyeX: scene.eye.x, actorX: scene.actors.get('self').container.x,
      cameraX: scene.cameras.main.scrollX + scene.cameras.main.width / 2 };
    ownBody.x = 620;
    scene.update(performance.now(), 16);
    const sameGenerationEyeX = scene.eye.x;
    ownBody.x = 650; ownBody.discontinuity = 'placed'; state.tick++;
    scene.update(performance.now(), 16);
    const placementEyeX = scene.eye.x;
    ownBody.x = 670;
    scene.update(performance.now(), 16);
    return { first, sameGenerationEyeX, placementEyeX, samePlacementEyeX: scene.eye.x };
  });
  assert.deepEqual(cut.first, { eyeX: 600, actorX: 600, cameraX: 600 }, 'generation change cuts the own actor and camera over a short move');
  assert.ok(cut.sameGenerationEyeX > 600 && cut.sameGenerationEyeX < 620, 'ordinary body motion still eases');
  assert.equal(cut.placementEyeX, 650, 'new placement marker cuts without generation change');
  assert.ok(cut.samePlacementEyeX > 650 && cut.samePlacementEyeX < 670, 'placement marker does not reset the eye every animation frame');
  assert.deepEqual(errors, []);
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
