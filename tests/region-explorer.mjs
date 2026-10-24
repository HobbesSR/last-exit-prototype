// Region Builder Explorer acceptance: node tests/region-explorer.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { REGION_TYPES, buildRegion } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { builtMapCollision } from '../map/micro/adapter.ts';
import { canOccupy } from '../shared/movement.ts';

const replayDir = await mkdtemp(path.join(os.tmpdir(), 'last-exit-region-explorer-'));
const { server, base, browser } = await serveWithBrowser({ replayDir, profileSummary: false, devTools: 'all' });
try {
  await mkdir('test-results', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/dev`);
  await page.getByRole('heading', { name: 'Region Builder Explorer' }).click();
  await page.waitForFunction(() => window.microLabDebug?.().result?.brief?.type === 'depot');
  const debug = () => page.evaluate(() => window.microLabDebug());
  const selectBuilder = async type => {
    await page.getByLabel('Builder', { exact: true }).selectOption(`region:${type}`);
    await page.waitForFunction(type => window.microLabDebug().result?.brief?.type === type, type);
  };
  assert.deepEqual((await debug()).result, JSON.parse(JSON.stringify(buildRegion(regionExample({ type: 'depot' })))));
  assert.ok((await debug()).portalRoutes.length > 0, 'game builders expose sampled hunter routes for the clearance overlay');
  assert.deepEqual(await page.locator('#builder optgroup').first().locator('option').evaluateAll(options => options.map(option => option.value)),
    Object.keys(REGION_TYPES).filter(type => !type.startsWith('example-')).sort().map(type => `region:${type}`));
  assert.equal(await page.locator('#builder option[value="region:market"]').textContent(), 'Market (hall strategy)');
  // Exercise the catalogue through the browser module loader, including core-site builders.
  for (const type of Object.keys(REGION_TYPES).filter(type => !type.startsWith('example-'))) {
    await selectBuilder(type);
    assert.ok((await debug()).avatar, `${type} has a walker on clear ground`);
  }
  // Each shape must produce its own build: compare with a direct one, whose cells differ from the
  // previous shape's, so a control that stopped regenerating cannot pass on the prior result.
  await selectBuilder('market');
  let previousCells = (await debug()).result.brief.cells;
  for (const [option, shape] of [['l', 'l'], ['hole', 'hole'], ['neck', 'neck'], ['cross', 'cross'], ['rect', 'rectangle'], ['stair', 'stair']]) {
    await page.getByLabel('Region shape', { exact: true }).selectOption(option);
    await page.getByRole('button', { name: 'Generate region', exact: true }).click();
    const expected = JSON.parse(JSON.stringify(buildRegion(regionExample({ type: 'market', shape }))));
    assert.notDeepEqual(expected.brief.cells, previousCells, `${shape} has its own cells`);
    assert.deepEqual((await debug()).result, expected, `${shape} control builds its own region`);
    previousCells = expected.brief.cells;
  }
  await selectBuilder('charging');
  await page.getByLabel('Width (cells)', { exact: true }).fill('32');
  await page.getByLabel('Height (cells)', { exact: true }).fill('24');
  await page.getByLabel('Seed', { exact: true }).fill('0');
  await page.getByLabel('Loot tier', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Generate region', exact: true }).click();
  const generated = await debug();
  const expected = buildRegion(regionExample({ type: 'charging', shape: 'stair', width: 32, height: 24, seed: 0, tier: 4 }));
  assert.deepEqual(generated.result, JSON.parse(JSON.stringify(expected)), 'controls feed the actual game builder');
  assert.ok(generated.result.coreElements.some(site => site.kind === 'charger'));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  assert.deepEqual(JSON.parse(await readFile(await (await download).path(), 'utf8')), generated.result);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal((await debug()).view.zoom, 1.5);
  const canvas = page.locator('#preview'), box = await canvas.boundingBox();
  const place = async point => {
    const { view } = await debug(), box = await canvas.boundingBox();
    await canvas.click({ position: { x: (view.offset.x + point.x * view.scale) * box.width / 960, y: (view.offset.y + point.y * view.scale) * box.height / 620 }, modifiers: ['Shift'] });
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 20); await page.mouse.up();
  assert.ok((await debug()).view.pan.x > 0, 'drag pans');
  await page.getByRole('button', { name: 'Fit region', exact: true }).click();
  assert.deepEqual((await debug()).view.pan, { x: 0, y: 0 });
  // Place on clear ground, then move with arrows using the actual collision simulation.
  await selectBuilder('open');
  const point = { x: 4 * 40, y: 4 * 40 };
  await place(point);
  const placed = await debug();
  assert.ok(Math.abs(placed.avatar.x - point.x) < 2, 'Shift-click places walker');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(x => window.microLabDebug().avatar.x > x, placed.avatar.x);
  await page.keyboard.up('ArrowRight');
  // Movement belongs to preview focus; leaving it also releases a held key.
  const moving = (await debug()).avatar.x;
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(x => window.microLabDebug().avatar.x > x, moving);
  await page.getByLabel('Seed', { exact: true }).focus();
  const stopped = (await debug()).avatar;
  await page.waitForTimeout(150);
  assert.deepEqual((await debug()).avatar, stopped, 'leaving preview focus stops held movement');
  await page.keyboard.up('ArrowRight');
  const prevented = await page.evaluate(() => {
    document.activeElement.blur();
    const event = new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, false, 'arrows outside the preview retain normal page handling');
  await page.waitForTimeout(150);
  assert.deepEqual((await debug()).avatar, stopped, 'arrows outside preview do not move the walker');
  await page.getByLabel('Walk as', { exact: true }).selectOption('gladiator');
  assert.equal((await debug()).avatar.role, 'gladiator');
  // A hole is excluded from the playable area, even when it has no obstacles.
  await page.getByLabel('Region shape', { exact: true }).selectOption('hole');
  const beforeHole = (await debug()).avatar;
  await place({ x: 16 * 40, y: 6 * 40 });
  assert.deepEqual((await debug()).avatar, beforeHole, 'placement refuses the hole');
  assert.match(await page.locator('#status').textContent(), /does not fit/);
  await page.getByLabel('Region shape', { exact: true }).selectOption('stair');
  await selectBuilder('compound');
  const compound = (await debug()).result;
  const collision = builtMapCollision({ cellSize: 40, regions: [compound], pairs: [] });
  const nearDoor = collision.gates.flatMap(gate => [-1, 1].map(sign => gate.w < gate.h
    ? { x: gate.x + sign * (gate.w / 2 + 40), y: gate.y }
    : { x: gate.x, y: gate.y + sign * (gate.h / 2 + 40) })).find(point => canOccupy(collision, point.x, point.y, 35));
  assert.ok(nearDoor, 'compound offers a clear approach to a door');
  await place(nearDoor);
  await page.keyboard.press('KeyE');
  assert.match(await page.locator('#status').textContent(), /Opened nearby gate/);
  await page.keyboard.press('KeyE');
  assert.match(await page.locator('#status').textContent(), /Closed nearby gate/);
  await page.screenshot({ path: 'test-results/region-explorer.png', fullPage: true });
  // Invalid dimensions fail clearly rather than building a different region.
  await page.getByLabel('Width (cells)', { exact: true }).fill('49');
  await page.getByRole('button', { name: 'Generate region', exact: true }).click();
  assert.equal((await debug()).result, null);
  assert.match(await page.locator('#status').textContent(), /width must be an integer from 8 to 48/);
  await page.getByLabel('Width (cells)', { exact: true }).fill('24');
  await page.getByRole('button', { name: 'Generate region', exact: true }).click();
  assert.ok((await debug()).result);
  // Imports preserve their artifact; controls still describe the selected example builder.
  await page.getByLabel('Builder', { exact: true }).selectOption('open');
  await page.locator('#import').setInputFiles({ name: 'charging.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(generated.result)) });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Loaded charging.json'));
  assert.equal((await debug()).imported, generated.result.brief.id);
  assert.equal(await page.getByLabel('Width (cells)', { exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#region-shape option[value="cross"]').evaluate(option => option.disabled), true);
  await page.getByLabel('Region shape', { exact: true }).selectOption('l');
  assert.equal((await debug()).result.spec.builder, 'open');
  assert.equal((await debug()).imported, null);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Region Builder Explorer browser acceptance passed.');
} finally {
  await browser.close(); await server.close(); await rm(replayDir, { recursive: true, force: true });
}
