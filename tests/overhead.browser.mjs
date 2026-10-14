// Retained overhead art: real Phaser pixels and texture lifecycle on a small controlled map.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';
import { generateLiveMap } from '../map/live.ts';

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
    const api = { map: () => window.fixture.map, state: () => state, self: () => player, playerId: () => player.id, directed: () => false,
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
    f.pixel = (wx = f.player.x, wy = f.player.y) => {
      const c = s.cameras.main, gl = f.game.renderer.gl, rgba = new Uint8Array(4);
      const px = Math.round((wx - c.worldView.x) * c.zoom), py = Math.round((wy - c.worldView.y) * c.zoom);
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
    return textures.length > 0 && textures.every(t => group.textures.has(t) && t.alpha === 0.5);
  });
  assert.equal(roofAlpha, true, 'roof groups also reuse textures for alpha changes');
  // Roof fade and inside zoom: the viewer walks to the door, then in, then out again.
  const frames = (n = 60, id = 'house') => page.evaluate(async ([n, id]) => { const s = window.fixture.scene; s.cutTo(); for (let i = 0; i < n; i++) { s.update(performance.now(), 16); await new Promise(r => setTimeout(r, 20)); } const g = s.roofs.get(id);
    return { alpha: g.alpha, visible: g.visible, zoom: s.cameras.main.zoom, textures: [...g.textures].map(t => t.alpha) }; }, [n, id]);
  await page.evaluate(() => { const f = window.fixture; f.map.gates.push({ id: 'door', x: 280, y: 296, w: 40, h: 18, open: false, locked: false, kind: 'door', buildingId: 'house' }); f.player.x = 700; f.player.y = 700; });
  const far = await frames();
  assert.equal(far.alpha, 1, 'a roof away from every opening stays opaque');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 300; f.player.y = 340; });
  const near = await frames();
  assert.ok(near.alpha < 0.5 && near.alpha > 0, `approaching a door fades the roof (${near.alpha})`);
  assert.ok(near.textures.every(a => a === near.alpha), 'fading reuses the cached textures');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 300; f.player.y = 200; });
  const inside = await frames();
  assert.equal(inside.alpha, 0); assert.equal(inside.visible, false, 'a roof fully faded stops being drawn');
  assert.ok(inside.zoom > far.zoom * 1.1, `the camera eases closer indoors (${far.zoom} -> ${inside.zoom})`);
  await page.evaluate(() => { const f = window.fixture; f.player.x = 700; f.player.y = 700; });
  const out = await frames();
  assert.equal(out.alpha, 1); assert.equal(out.visible, true); assert.ok(Math.abs(out.zoom / far.zoom - 1) < 0.01, `leaving restores the zoom (${far.zoom} -> ${out.zoom})`);
  // A declared L-shaped roof beside the plain building (#292). Its id is its building's, as stamping
  // gives it, so the plain-building passes must skip the building it covers. A new map object, as
  // the client's changeMap gives, since the roof index is cached per map.
  await page.evaluate(() => { const f = window.fixture;
    f.map = { ...f.map, buildings: [...f.map.buildings, { id: 'hall', x: 1000, y: 100, w: 80, h: 80 }],
      roofs: [{ id: 'hall', groupId: 'hall', buildingId: 'hall', bounds: { x: 1000, y: 100, w: 80, h: 80 }, origin: { x: 1000, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }] };
    f.scene.buildMap(); });
  const mixed = await frames(60, 'hall'), plain = await frames(1);
  assert.equal(mixed.alpha, 1, 'a declared roof away from its openings stays opaque');
  assert.equal(plain.alpha, 1, 'the plain building keeps its own roof on a mixed map');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 1060; f.player.y = 160; });
  assert.equal((await frames(60, 'hall')).alpha, 1, 'the notch of the L is outside the declared roof');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 1020; f.player.y = 160; });
  const underL = await frames(60, 'hall');
  assert.equal(underL.alpha, 0, 'inside a declared roof fades it away');
  assert.equal((await frames(1)).alpha, 1, 'the plain building stays roofed while inside the declared one');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 700; f.player.y = 700; });

  // Two physically abutting declared roofs with different fade groups (#349).
  // Roof west at (2000, 100), 40x40, groupId: 'group-w'.
  // Roof east at (2040, 100), 40x40, groupId: 'group-e'.
  await page.evaluate(() => {
    const f = window.fixture;
    f.map = {
      ...f.map,
      buildings: [],
      roofs: [
        { id: 'room-w', groupId: 'group-w', bounds: { x: 2000, y: 100, w: 40, h: 40 }, origin: { x: 2000, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
        { id: 'room-e', groupId: 'group-e', bounds: { x: 2040, y: 100, w: 40, h: 40 }, origin: { x: 2040, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
      ],
    };
    f.scene.buildMap();
    f.scene.cutTo();
    f.player.x = 2020; f.player.y = 300;
  });
  const bothOpaque = await frames(30, 'room-w');
  const eastOpaque = await frames(1, 'room-e');
  assert.equal(bothOpaque.alpha, 1);
  assert.equal(eastOpaque.alpha, 1);
  // Assert no line stroke (128,145,168) or dark base seam at the shared wall (x=2040) between abutting roofs (#349)
  const interiorPixel = await page.evaluate(() => window.fixture.pixel(2020, 120));
  const seamPixel = await page.evaluate(() => window.fixture.pixel(2040, 120));
  const westOfSeam = await page.evaluate(() => window.fixture.pixel(2038, 120));
  const eastOfSeam = await page.evaluate(() => window.fixture.pixel(2042, 120));
  const westOuterPixel = await page.evaluate(() => window.fixture.pixel(1988, 120));
  assert.deepEqual(westOfSeam.slice(0, 3), interiorPixel.slice(0, 3), 'west side of shared wall matches interior fill');
  assert.deepEqual(eastOfSeam.slice(0, 3), interiorPixel.slice(0, 3), 'east side of shared wall matches interior fill');
  assert.ok(seamPixel[0] >= 65 && seamPixel[0] < 100 && seamPixel[1] < 110, 'shared seam has continuous fill and rejects bright stroke color');
  assert.deepEqual(westOuterPixel.slice(0, 3), [128, 145, 168], `outer exterior roof edge retains perimeter line stroke (got rgb ${westOuterPixel.slice(0,3)})`);
  await page.screenshot({ path: 'test-results/overhead-abutting-roofs.png' });

  // Staggered abutting roofs: verify contacted portion has continuous fill while exposed portions retain overhang & strokes (#349)
  await page.evaluate(async () => {
    const f = window.fixture, s = f.scene;
    f.map = {
      ...f.map,
      buildings: [],
      roofs: [
        { id: 'stag-w', groupId: 'g-sw', bounds: { x: 3000, y: 100, w: 40, h: 40 }, origin: { x: 3000, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
        { id: 'stag-e', groupId: 'g-se', bounds: { x: 3040, y: 110, w: 40, h: 40 }, origin: { x: 3040, y: 110 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
      ],
    };
    f.player.x = 3020; f.player.y = 70;
    s.buildMap();
    s.cutTo();
  });
  await frames(30, 'stag-w');
  const stagContactSeam = await page.evaluate(() => window.fixture.pixel(3040, 125));
  const stagWestSide = await page.evaluate(() => window.fixture.pixel(3038, 125));
  const stagEastSide = await page.evaluate(() => window.fixture.pixel(3042, 125));
  const stagWestOuterStroke = await page.evaluate(() => window.fixture.pixel(2988, 120));
  const stagEastExposedOverhang = await page.evaluate(() => window.fixture.pixel(3028, 145));
  assert.deepEqual(stagWestSide.slice(0, 3), interiorPixel.slice(0, 3), 'west side of contacted staggered edge matches interior fill');
  assert.deepEqual(stagEastSide.slice(0, 3), interiorPixel.slice(0, 3), 'east side of contacted staggered edge matches interior fill');
  assert.ok(stagContactSeam[0] >= 65 && stagContactSeam[0] < 100, 'contacted portion of staggered edge rejects stroke color');
  assert.deepEqual(stagWestOuterStroke.slice(0, 3), [128, 145, 168], 'outer west perimeter of stag-w retains stroke');
  assert.deepEqual(stagEastExposedOverhang.slice(0, 3), [128, 145, 168], 'partially exposed west segment of stag-e retains overhang stroke');

  // North/South staggered abutting roofs at distinct X/Y origins (#349 review)
  await page.evaluate(async () => {
    const f = window.fixture, s = f.scene;
    f.map = {
      ...f.map,
      buildings: [],
      roofs: [
        { id: 'stag-s', groupId: 'g-ss', bounds: { x: 3000, y: 100, w: 40, h: 40 }, origin: { x: 3000, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
        { id: 'stag-n', groupId: 'g-sn', bounds: { x: 3020, y: 60, w: 40, h: 40 }, origin: { x: 3020, y: 60 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
      ],
    };
    f.player.x = 3020; f.player.y = 30;
    s.buildMap();
    s.cutTo();
  });
  await frames(30, 'stag-s');
  const nsContactSeam = await page.evaluate(() => window.fixture.pixel(3030, 100));
  const nsNorthSide = await page.evaluate(() => window.fixture.pixel(3030, 98));
  const nsSouthSide = await page.evaluate(() => window.fixture.pixel(3030, 102));
  const nsSouthExposedOverhang = await page.evaluate(() => window.fixture.pixel(3004, 88));
  const nsNorthExposedOverhang = await page.evaluate(() => window.fixture.pixel(3056, 112));
  assert.deepEqual(nsNorthSide.slice(0, 3), interiorPixel.slice(0, 3), 'north side of contacted NS edge matches interior fill');
  assert.deepEqual(nsSouthSide.slice(0, 3), interiorPixel.slice(0, 3), 'south side of contacted NS edge matches interior fill');
  assert.ok(nsContactSeam[0] >= 65 && nsContactSeam[0] < 100, 'contacted portion of NS edge rejects stroke color');
  assert.deepEqual(nsSouthExposedOverhang.slice(0, 3), [128, 145, 168], 'exposed north overhang of stag-s retains stroke');
  assert.deepEqual(nsNorthExposedOverhang.slice(0, 3), [128, 145, 168], 'exposed south overhang of stag-n retains stroke');

  // Inside room-w fades room-w, while room-e in group-e stays opaque
  await page.evaluate(() => {
    const f = window.fixture;
    f.map = {
      ...f.map,
      buildings: [],
      roofs: [
        { id: 'room-w', groupId: 'group-w', bounds: { x: 2000, y: 100, w: 40, h: 40 }, origin: { x: 2000, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
        { id: 'room-e', groupId: 'group-e', bounds: { x: 2040, y: 100, w: 40, h: 40 }, origin: { x: 2040, y: 100 }, cellSize: 40, cells: [{ x: 0, y: 0 }] },
      ],
    };
    f.scene.buildMap();
    f.scene.cutTo();
    f.player.x = 2020; f.player.y = 120;
  });
  const westFaded = await frames(60, 'room-w');
  const eastStillOpaque = await frames(1, 'room-e');
  assert.equal(westFaded.alpha, 0, 'inside room-w fades room-w');
  assert.equal(eastStillOpaque.alpha, 1, 'room-e in another group remains opaque');
  await page.evaluate(() => { const f = window.fixture; f.player.x = 700; f.player.y = 700; });

  // Screenshot a multi-room compound (#349)
  const compoundMap = generateLiveMap(1);
  await page.evaluate(async map => {
    const f = window.fixture, s = f.scene;
    f.map = map;
    const firstCompound = map.roofs.find(r => r.id.startsWith('compound') || r.groupId.includes('compound') || r.groupId.includes('ring'));
    if (firstCompound) {
      f.player.x = firstCompound.bounds.x + firstCompound.bounds.w / 2;
      f.player.y = firstCompound.bounds.y - 120;
    }
    s.buildMap();
    s.cutTo();
    for (let i = 0; i < 40; i++) {
      s.update(performance.now(), 16);
      await new Promise(r => setTimeout(r, 20));
    }
  }, compoundMap);
  const compoundOverheadCount = await page.evaluate(() => {
    const s = window.fixture.scene;
    let count = 0;
    for (const [key, g] of s.overheadGroups) {
      if (key.startsWith('roof:') && g.visible && g.textures.size > 0) count++;
    }
    return count;
  });
  assert.ok(compoundOverheadCount > 0, 'compound roof overhead textures are built and visible');
  await page.screenshot({ path: 'test-results/overhead-compound.png' });
  // Restore original map with canopy around (500, 400) for texture lifecycle cleanup checks
  await page.evaluate(() => {
    const f = window.fixture;
    f.map = {
      seed: 1, width: 5000, height: 3000, modules: [], hazards: [], gaps: [], stations: [], sensors: [], gates: [], routes: [],
      buildings: [{ id: 'house', x: 100, y: 100, w: 412, h: 200 }], obstacles: [{ id: 'tree', kind: 'tree', x: 450, y: 400, r: 32 }],
    };
    f.scene.buildMap();
    f.scene.cutTo();
  });

  // Pan far enough to release the original textures, then rebuild the map with no overhead art.
  const cleanup = await page.evaluate(() => {
    const f = window.fixture, s = f.scene;
    s.cameras.main.centerOn(4500, 2500); s.updateTiles();
    const released = f.textures.every(t => !t.scene);
    const remaining = [...s.overheadTiles.values()].filter(t => t.texture).length;
    s.cameras.main.centerOn(500, 400);
    for (let i = 0; i < 8; i++) s.updateTiles();
    const rebuilt = [...s.overheadGroups.values()].flatMap(g => [...g.textures]);
    f.map = { ...f.map, obstacles: [], buildings: [], roofs: [] }; s.buildMap();
    return { released, remaining, mapReleased: rebuilt.length > 0 && rebuilt.every(t => !t.scene), roofCount: s.roofs.size, tileCount: s.overheadTiles.size, drawings: s.overheadDrawings.length };
  });
  assert.deepEqual(cleanup, { released: true, remaining: 0, mapReleased: true, roofCount: 0, tileCount: 0, drawings: 0 });
  assert.deepEqual(errors, []);
  console.log('Overhead browser checks passed');
} finally {
  await browser.close();
  await server.close();
}
