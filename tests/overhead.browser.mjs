// Retained overhead art: real Phaser pixels and texture lifecycle on a small controlled map.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

await mkdir('test-results', { recursive: true });
const server = await createArenaServer({ profileSummary: false });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/overhead-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><script type="importmap">{"imports":{"sat":"/sat-browser.js"}}</script><script src="/vendor/sat/SAT.js"></script><script src="/vendor/phaser/phaser.min.js"></script></body></html>' }));
  await page.goto(`${base}/overhead-fixture`);
  await page.evaluate(async () => {
    const { makeArenaScene } = await import('/arena-scene.js');
    const map = { seed: 1, width: 5000, height: 3000, modules: [], hazards: [], gaps: [], stations: [], sensors: [], gates: [], routes: [],
      // The roof ends exactly at a tile boundary: seam indexing also visits an empty cropped tile.
      buildings: [{ id: 'house', x: 100, y: 100, w: 412, h: 200 }], obstacles: [{ id: 'tree', kind: 'tree', x: 450, y: 400, r: 32 }] };
    const player = { id: 'self', name: 'Tester', role: 'contestant', x: 500, y: 400, heading: 0, status: 'active', hp: 100, maxHp: 100 };
    const state = { tick: 1, players: [player], gates: [], items: [], traps: [], projectiles: [], effects: [] };
    const api = { map: () => map, state: () => state, self: () => player, playerId: () => player.id, directed: () => false,
      follow: () => null, replay: () => false, onFrame() {}, onReady(scene) { window.fixture.scene = scene; }, onFire() {}, frameAlpha: () => 0, aim: () => 0 };
    window.fixture = { map, player, state };
    window.fixture.game = new Phaser.Game({ type: Phaser.WEBGL, width: 900, height: 700, audio: { noAudio: true }, render: { preserveDrawingBuffer: true }, scene: makeArenaScene(api) });
  });
  await page.waitForFunction(() => window.fixture.scene?.overheadGroups?.size && window.fixture.scene.overheadGroups.get('canopy').textures.size);
  await page.waitForTimeout(300);
  // Checks below use actual cached textures, not the Graphics command list.
  const initial = await page.evaluate(() => {
    const s = window.fixture.scene;
    return { groups: [...s.overheadGroups].map(([id, g]) => ({ id, kind: g.kind, textures: [...g.textures].map(t => t.type) })),
      roof: s.roofs.get('house').visible };
  });
  assert.ok(initial.groups.find(g => g.id === 'canopy').textures.every(t => t === 'RenderTexture'));
  assert.equal(initial.roof, true, 'outside roof remains visible');
  await page.screenshot({ path: 'test-results/overhead-canopy.png' });
  await page.evaluate(() => {
    const f = window.fixture, s = f.scene;
    s.scene.pause();
    f.textures = [...s.overheadGroups.get('canopy').textures];
    f.rasterisations = 0;
    const rasterise = s.rasterise.bind(s);
    s.rasterise = (...args) => { f.rasterisations++; return rasterise(...args); };
    f.pixel = () => {
      const c = s.cameras.main, gl = f.game.renderer.gl, rgba = new Uint8Array(4);
      const px = Math.round((f.player.x - c.worldView.x) * c.zoom), py = Math.round((f.player.y - c.worldView.y) * c.zoom);
      gl.readPixels(px, gl.drawingBufferHeight - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return [...rgba];
    };
  });
  const covered = await page.evaluate(() => window.fixture.pixel());
  await page.evaluate(() => window.fixture.scene.setOverheadGroup('canopy', true, 0));
  await page.waitForTimeout(60);
  const uncovered = await page.evaluate(() => window.fixture.pixel());
  assert.notDeepEqual(covered, uncovered, 'crown extends past trunk and occludes an actor beneath it');
  await page.evaluate(() => window.fixture.scene.setOverheadGroup('canopy', true, 0.4));
  await page.waitForTimeout(60);
  const faded = await page.evaluate(() => window.fixture.pixel());
  assert.notDeepEqual(faded, covered, 'group alpha changes the rendered crown');
  assert.notDeepEqual(faded, uncovered, 'intermediate alpha retains overhead art');
  const retained = await page.evaluate(() => {
    const f = window.fixture, g = f.scene.overheadGroups.get('canopy');
    return { same: f.textures.every(t => g.textures.has(t)), alpha: [...g.textures].map(t => t.alpha), rasterisations: f.rasterisations };
  });
  assert.equal(retained.same, true, 'alpha changes reuse textures');
  assert.ok(retained.alpha.every(a => a === 0.4));
  assert.equal(retained.rasterisations, 0, 'fading does not rasterise');
  const roofAlpha = await page.evaluate(() => {
    const s = window.fixture.scene, group = s.roofs.get('house'), textures = [...group.textures];
    s.setOverheadGroup('roof:house', true, 0.5);
    s.update(performance.now(), 16);
    return textures.length > 0 && textures.every(t => group.textures.has(t) && t.alpha === 0.5);
  });
  assert.equal(roofAlpha, true, 'roof groups also reuse textures for alpha changes');
  // Pan far enough to release the original textures, then rebuild the map with no overhead art.
  const cleanup = await page.evaluate(() => {
    const f = window.fixture, s = f.scene;
    s.cameras.main.centerOn(4500, 2500); s.updateTiles();
    const released = f.textures.every(t => !t.scene);
    const remaining = [...s.overheadTiles.values()].filter(t => t.texture).length;
    s.cameras.main.centerOn(500, 400);
    for (let i = 0; i < 8; i++) s.updateTiles();
    const rebuilt = [...s.overheadGroups.values()].flatMap(g => [...g.textures]);
    f.map.obstacles = []; f.map.buildings = []; s.buildMap();
    return { released, remaining, mapReleased: rebuilt.length > 0 && rebuilt.every(t => !t.scene), roofCount: s.roofs.size, tileCount: s.overheadTiles.size, drawings: s.overheadDrawings.length };
  });
  assert.deepEqual(cleanup, { released: true, remaining: 0, mapReleased: true, roofCount: 0, tileCount: 0, drawings: 0 });
  assert.deepEqual(errors, []);
  console.log('Overhead browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
