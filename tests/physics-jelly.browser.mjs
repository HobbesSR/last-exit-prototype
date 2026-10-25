import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { captureJellyWitnesses } from '../tools/physics/jelly.mjs';
import { playbackHtml } from '../tools/physics/jelly-report.mjs';

const recording = await captureJellyWitnesses();
assert.equal(recording.schema, 'jelly-lab-recording-1');
assert.ok(recording.witnesses.length >= 2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 }, acceptDownloads: true });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.setContent(await playbackHtml(recording));
  await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('tick '));
  assert.equal(await page.locator('#witness option').count(), recording.witnesses.length);
  let changedGeometry = 0;
  for (const witness of recording.witnesses) {
    await page.getByLabel('Witness', { exact: true }).selectOption({ label: witness.name });
    const first = witness.frames[0];
    const last = witness.frames.at(-1);
    for (const frame of [last, first, witness.frames[Math.floor(witness.frames.length / 2)]]) {
      await page.getByLabel('Tick', { exact: true }).fill(String(frame.tick));
      const shown = JSON.parse(await page.locator('pre').textContent());
      const expected = JSON.parse(JSON.stringify({ tick: frame.tick, compression: frame.compression,
        events: frame.events, bodies: frame.bodies }));
      assert.deepEqual(shown, expected, `${witness.name} tick ${frame.tick}`);
    }
    const signatures = new Set();
    for (const frame of [first, witness.frames[Math.floor(witness.frames.length / 2)], last]) {
      await page.getByLabel('Tick', { exact: true }).fill(String(frame.tick));
      signatures.add(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()));
    }
    if (signatures.size > 1) changedGeometry++;
  }
  assert.ok(changedGeometry >= 2, 'multiple scenes redraw visibly different retained geometry');
  async function colorBounds(rgb) {
    return page.locator('canvas').evaluate((canvas, color) => {
      const { width, height } = canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      let left = width, right = -1, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] !== color[0] || data[i + 1] !== color[1] || data[i + 2] !== color[2]) continue;
        left = Math.min(left, x); right = Math.max(right, x); count++;
      }
      return { left, right, count };
    }, rgb);
  }
  const ringWitness = recording.witnesses.find(w => w.jelly.ringIds.length);
  await page.getByLabel('Witness', { exact: true }).selectOption({ label: ringWitness.name });
  assert.ok((await colorBounds([255, 212, 133])).count > 0, 'fixed core outline is drawn');
  assert.ok((await colorBounds([149, 255, 224])).count > 0, 'deformable ring nodes are drawn');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/physics-jelly-ring-playback.png', fullPage: true });
  const playerWitness = recording.witnesses.find(w => w.name === 'opposed player squeeze');
  const peak = playerWitness.frames.reduce((best, frame) => frame.compression.amount > best.compression.amount ? frame : best);
  assert.ok(peak.compression.amount > 0, 'opposed scene actually compresses');
  await page.getByLabel('Witness', { exact: true }).selectOption({ label: playerWitness.name });
  const blueAtRest = await colorBounds([77, 179, 220]);
  const coreAtRest = await colorBounds([255, 212, 133]);
  await page.getByLabel('Tick', { exact: true }).fill(String(peak.tick));
  const blueAtPeak = await colorBounds([77, 179, 220]);
  const coreAtPeak = await colorBounds([255, 212, 133]);
  assert.ok(blueAtRest.count > 0 && blueAtPeak.count > 0, 'player squish ellipse is drawn');
  assert.ok(coreAtRest.count > 0 && coreAtPeak.count > 0, 'player solid core outline is drawn');
  assert.ok(Math.abs((coreAtPeak.right - coreAtPeak.left) - (coreAtRest.right - coreAtRest.left)) <= 2,
    'player solid core outline keeps its width within pixel rounding');
  assert.ok(blueAtPeak.right - blueAtPeak.left < blueAtRest.right - blueAtRest.left,
    'the player visual ellipse narrows along the compression axis');
  await page.screenshot({ path: 'test-results/physics-jelly-playback.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'physics-jelly.json');
  const exported = await (await download.createReadStream()).toArray();
  assert.deepEqual(JSON.parse(Buffer.concat(exported).toString('utf8')), JSON.parse(JSON.stringify(recording)));
  await page.getByRole('button', { name: 'Reset' }).click();
  assert.equal(Number(await page.getByLabel('Tick', { exact: true }).inputValue()), recording.witnesses.at(-1).frames[0].tick);
  await page.getByLabel('Speed', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(160);
  assert.ok(Number(await page.getByLabel('Tick', { exact: true }).inputValue()) >= 2,
    '1× playback advances at the retained 50 ms tick rate');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByLabel('Speed', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForFunction(() => Number(document.querySelector('#tick').value) > 0);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByLabel('Tick', { exact: true }).fill(String(recording.witnesses.at(-1).frames.at(-1).tick));
  await page.getByRole('button', { name: 'Play' }).click();
  assert.equal(Number(await page.getByLabel('Tick', { exact: true }).inputValue()), recording.witnesses.at(-1).frames[0].tick,
    'playing from the end replays from the first frame');
  await page.getByRole('button', { name: 'Pause' }).click();
  assert.deepEqual(requests, [], 'standalone playback makes no network requests');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), witnesses: recording.witnesses.length,
    checks: ['forward/backward retained seek', 'canvas changes', 'offline playback', 'export', 'play/pause/speed/reset/replay'] }));
} finally { await browser.close(); }
