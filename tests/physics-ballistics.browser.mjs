import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { playbackHtml } from '../tools/physics/ballistic-report.mjs';

const retained = JSON.parse(await readFile('docs/reports/physics-p7-traces.json', 'utf8'));
const report = { schema: retained.schema, profile: retained.profile, limitations: retained.limitations, witnesses: retained.witnesses };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  // A standalone recording opens with no network or solver/bootstrap available.
  await page.setContent(await playbackHtml(report));
  await page.waitForFunction(() => document.querySelector('output').textContent.includes('tick 0'));
  assert.equal(await page.locator('option').count(), report.witnesses.length);
  for (const witness of report.witnesses) {
    await page.getByLabel('Witness', { exact: true }).selectOption({ label: witness.name });
    for (const tick of [witness.frames.at(-1).tick, 0, Math.min(3, witness.frames.length - 1)]) {
      await page.getByLabel('Tick', { exact: true }).fill(String(tick));
      const shown = JSON.parse(await page.locator('pre').textContent());
      const expected = witness.frames[tick];
      assert.deepEqual(shown, { tick, state: expected.state, events: expected.events });
    }
  }
  await page.getByLabel('Witness', { exact: true }).selectOption({ label: 'low-cover' });
  await page.getByLabel('Tick', { exact: true }).fill('8');
  const pixels = await page.locator('canvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d');
    // Frame 8: x60, ground y50, bottom height28. Ground shadow and cube differ in height.
    return { shadow: [...ctx.getImageData(240, 240, 1, 1).data], cube: [...ctx.getImageData(240, 180, 1, 1).data] };
  });
  assert.deepEqual(pixels.shadow, [5, 9, 12, 255]);
  assert.deepEqual(pixels.cube, [255, 211, 107, 255]);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/physics-p7-playback.png', fullPage: true });
  assert.deepEqual(requests, [], 'playback has no dependency or engine requests');
  // Separately execute the same pure solver/witness modules in Chrome, without a server.
  const solver = await readFile('tools/physics/ballistics.mjs', 'utf8');
  const witnesses = (await readFile('tools/physics/ballistic-witness.mjs', 'utf8'))
    .replace("import { PROFILE, createThrow, stepThrow, displayThrow } from './ballistics.mjs';", '');
  const chrome = await page.evaluate(async source => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return (await import(url)).captureWitnesses(); } finally { URL.revokeObjectURL(url); }
  }, solver + '\n' + witnesses);
  assert.deepEqual(chrome, report, 'Node/Chrome full retained trajectory equality');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, browser: browser.version(), witnesses: report.witnesses.length,
    checks: ['retained seek forward/backward', 'actual shadow/cube pixels', 'standalone engine-free playback', 'Node/Chrome trajectory equality'] }));
} finally { await browser.close(); }
