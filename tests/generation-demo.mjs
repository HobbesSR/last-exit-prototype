// Standalone acceptance for the decomposition-to-physical-geometry demonstration.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { generate } from '../map/tools/core.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { briefFragment } from '../map/micro/brief-link.ts';
import { buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';

const replayDir = await mkdtemp(path.join(os.tmpdir(), 'last-exit-generation-demo-'));
await mkdir('test-results', { recursive: true });
const { server, base, browser } = await serveWithBrowser({ replayDir, profileSummary: false, devTools: 'all' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(`${base}/dev/micro/generation`);
  await page.waitForFunction(() => window.generationDemoDebug?.().result, null, { timeout: 15000 });
  await assert.doesNotReject(() => page.getByText('ownership boundary', { exact: false }).waitFor());
  // With no link, the example controls make a block brief and show what `buildRegion` built for it.
  const initial = await page.evaluate(() => window.generationDemoDebug());
  const example = regionExample({ type: 'block', seed: 4217, shape: 'neck', width: 36, height: 30 });
  assert.equal(initial.linked, false);
  assert.deepEqual(initial.shown.built, JSON.parse(JSON.stringify(buildRegion(example))), 'the demo shows the block the example brief builds');
  assert.ok(initial.result.assignments.filter(a => a.role === 'lot').length >= 2, 'the example has several lots');
  assert.ok(initial.result.assignments.some(a => a.role === 'alleys'), 'the example has alleys between its lots');
  assert.ok(initial.result.assignments.every(a => Object.hasOwn(REGION_TYPES, a.builder)), 'every child has a registered builder');
  // Each stage shares one fitted desktop preview; pointer coordinates follow its CSS size.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const stage of ['region', 'decomposition', 'generated', 'walk']) {
      await page.locator(`[data-stage="${stage}"]`).click();
      await page.waitForFunction(() => {
        const rect = document.querySelector('#preview').getBoundingClientRect();
        const view = window.generationDemoDebug().view;
        return Math.abs(rect.width - view.width) < 1 && Math.abs(rect.height - view.height) < 1;
      });
      assert.equal(await page.evaluate(() => { const canvas = document.querySelector('#preview'); return Math.abs(canvas.width - canvas.getBoundingClientRect().width * devicePixelRatio) <= 1; }), true, 'canvas bitmap matches display density');
      const box = await page.locator('#preview').boundingBox();
      assert.ok(box.width > 200 && box.height > 200, 'active preview has useful drawing space');
      if (viewport.width > 900) {
        assert.ok(box.y + box.height <= viewport.height, 'desktop preview stays in the viewport');
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'desktop panels scroll independently');
      }
      if (stage !== 'region') {
        const target = await page.evaluate(() => {
          const d = window.generationDemoDebug(), r = d.result.regions.at(-1), c = r.spec.cells[0], size = d.result.plan.context.cellSize;
          return { id: r.spec.id, x: d.view.offset.x + (c.x + .5) * size * d.view.scale, y: d.view.offset.y + (c.y + .5) * size * d.view.scale };
        });
        await page.locator('#preview').click({ position: { x: target.x, y: target.y } });
        assert.equal(await page.locator('#piece').inputValue(), target.id, 'canvas selects the child under the pointer after resizing');
        await page.locator('[data-stage="region"]').click();
        await page.locator(`[data-stage="${stage}"]`).click();
        assert.equal(await page.locator('#piece').inputValue(), target.id, 'stage switching retains child selection');
      }
      await page.screenshot({ path: `test-results/generation-workspace-${viewport.width}-${stage}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/generation-demo-example.png', fullPage: true });
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.generationDemoDebug().stage), 'region');
  assert.equal(await page.evaluate(() => window.generationDemoDebug().walker), null, 'region stage has no walker');
  await page.getByRole('button', { name: 'Decomposition', exact: true }).click();
  assert.equal(await page.evaluate(() => window.generationDemoDebug().walker), null, 'decomposition stage has no walker');
  await page.getByRole('button', { name: 'Generated', exact: true }).click();
  assert.equal(await page.evaluate(() => window.generationDemoDebug().walker), null, 'generated stage has no walker');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  assert.ok(await page.evaluate(() => window.generationDemoDebug().walker), 'walk stage creates the walker');
  await page.getByLabel('Seed').fill('8123'); await page.getByLabel('Seed').press('Enter');
  await page.waitForFunction(() => window.generationDemoDebug().result?.seed === 8123);
  const seeded = await page.evaluate(() => window.generationDemoDebug());
  assert.notDeepEqual(seeded.shown.built.elements, initial.shown.built.elements, 'seed changes physical geometry');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download JSON' }).click(); const file = await download;
  assert.match(file.suggestedFilename(), /^region-block-8123\.json$/);
  assert.deepEqual(JSON.parse(await readFile(await file.path(), 'utf8')), seeded.shown.built, 'download preserves the block result');
  await page.getByLabel('Example shape').selectOption('rectangle');
  await page.waitForFunction(() => window.generationDemoDebug().shown?.built.brief.cells.length === 36 * 30);
  const alleys = await page.evaluate(() => window.generationDemoDebug().result.assignments.find(a => a.role === 'alleys').pieceId);
  await page.getByLabel('Region assignment').selectOption(alleys);
  await page.getByRole('button', { name: 'Reset walker here' }).click();
  const start = await page.evaluate(() => window.generationDemoDebug().walker);
  await page.locator('#preview').click(); await page.keyboard.down('KeyD');
  await page.waitForFunction(x => window.generationDemoDebug().walker.x !== x, start.x, { timeout: 7000 });
  await page.keyboard.up('KeyD');
  await page.screenshot({ path: 'test-results/generation-demo.png', fullPage: true });
  // A chain map's block, opened by the Map Lab's link (20.5): its lots and alleys, the geometry
  // the map stored for it, and a walk through it with the game's collision.
  const blockMap = generate('last-exit-004'), blockBrief = mapViews(blockMap).briefs.find(b => b.type === 'block');
  await page.goto(`${base}/dev/micro/generation${await briefFragment(blockBrief)}`);
  await page.waitForFunction(id => window.generationDemoDebug?.().linked && window.generationDemoDebug().shown?.id === id, blockBrief.id, { timeout: 15000 });
  const block = await page.evaluate(() => window.generationDemoDebug());
  assert.deepEqual(block.shown.built, JSON.parse(JSON.stringify(blockMap.results.find(r => r.brief.id === blockBrief.id))), 'the demo shows the block the map stored');
  assert.ok(block.result.assignments.some(a => a.role === 'lot'), 'the block has generated lots');
  assert.ok(block.result.assignments.some(a => a.role === 'alleys'), 'the block has circulation between its lots');
  assert.ok(block.result.assignments.every(a => Object.hasOwn(REGION_TYPES, a.builder)), 'every child has a registered builder');
  assert.equal(new Set(block.result.assignments.map(a => a.pieceId)).size, block.result.assignments.length, 'each child has a unique assignment');
  assert.ok(block.shown.built.elements.length > 0, 'the linked block has generated elements to display');
  assert.deepEqual(block.result.regions.flatMap(r => r.elements), block.shown.built.elements, 'every generated element belongs to one child exactly once');
  assert.ok(block.result.regions.some(r => r.manifest.structures > 0 || r.manifest.obstacles > 0), 'child inspection reports the generated geometry');
  assert.ok(block.walker, 'the walk stage places a walker in the block');
  await page.getByRole('button', { name: 'Decomposition', exact: true }).click();
  await page.screenshot({ path: 'test-results/generation-demo-block.png', fullPage: true });
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  const walked = await page.evaluate(() => window.generationDemoDebug().walker);
  await page.locator('#preview').click(); await page.keyboard.down('KeyD');
  await page.waitForFunction(x => window.generationDemoDebug().walker.x !== x, walked.x, { timeout: 7000 });
  await page.keyboard.up('KeyD');
  // A region that doesn't decompose says so, and the example shows instead.
  const hutBrief = mapViews(blockMap).briefs.find(b => b.type === 'hut') ?? mapViews(generate('last-exit-001')).briefs.find(b => b.type === 'hut');
  await page.goto(`${base}/dev/micro/generation${await briefFragment(hutBrief)}`);
  await page.waitForFunction(() => window.generationDemoDebug?.().shown && !window.generationDemoDebug().linked);
  assert.match(await page.locator('#status').textContent(), /doesn't decompose/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile demo has no horizontal overflow');
  assert.deepEqual(errors, [], errors.join('\n'));
} finally { await browser.close(); await server.close(); await rm(replayDir, { recursive: true, force: true }); }
