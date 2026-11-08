/** Focused Map Lab placement replay acceptance; run from the repository root. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tracePlacement } from '../placement-trace.ts';
// @ts-expect-error JavaScript server and helper have no declarations.
import { createArenaServer } from '../../../server/index.js';
// @ts-expect-error JavaScript server and helper have no declarations.
import { listen } from '../../../tests/helpers/listen.js';

const playwright = createRequire(import.meta.url)('@playwright/test');
const out = 'test-results/map-lab';
await mkdir(out, { recursive: true });
const replayDir = await mkdtemp(path.join(tmpdir(), 'placement-browser-'));
const game = await createArenaServer({ replayDir, profileSummary: false, devTools: 'all' });
let browser: any;
try {
  const url = await listen(game);
  browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${url}/dev/map`, { waitUntil: 'domcontentloaded' });
  await page.locator('#seed').fill('sweep-66');
  await page.locator('#librarySource').selectOption('bundled');
  await page.locator('#solveTab').click();
  await page.locator('#solveRecord').click();
  await page.waitForFunction(() => (document.querySelector('#solveCancel') as HTMLButtonElement).disabled, null, { timeout: 60000 });
  const snapshot = () => page.evaluate(() => (window as any).mapLab.snapshot().placement);
  const initial = await snapshot();
  const trace = tracePlacement('sweep-66');
  assert.equal(initial.seed, trace.seed, await page.locator('#solveStatus').innerText());
  assert.equal(initial.events, trace.events.length);
  assert.ok(initial.events > 0 && !trace.truncated);
  assert.match(await page.locator('#solveRecipe').innerText(), /sweep-66.*bundled/);
  const attempts = [...new Set(trace.events.map(event => event.attempt))];
  assert.ok(attempts.length > 1, 'fixture exercises attempt selection');
  for (const attempt of attempts) {
    await page.locator('#solveAttempt').selectOption(String(attempt));
    const events = trace.events.filter(event => event.attempt === attempt);
    const tiles = new Set<number>();
    const checks = new Set([0, Math.floor(events.length / 2), events.length - 1]);
    let refusalIndex = -1;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === 'set-piece-slot') tiles.add(event.slot);
      if (event.type === 'collapse') for (const slot of event.slots) tiles.add(slot.slot);
      if (event.type === 'undo') for (const slot of event.slots) tiles.delete(slot);
      if (event.type === 'refusal' && refusalIndex < 0) { refusalIndex = i; checks.add(i); }
      if (!checks.has(i)) continue;
      await page.locator('#solveStep').evaluate((input: HTMLInputElement, n: number) => { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles: true })); }, i);
      const current = await snapshot();
      assert.equal(current.attempt, attempt);
      assert.equal(current.index, i);
      assert.equal(current.collapsed, tiles.size, `attempt ${attempt}, event ${i}`);
      assert.deepEqual(current.event, event);
      assert.match(await page.locator('#solveCounters').innerText(), /Depth \d+.*Node \d+.*Stall \d+/);
    }
    // Seeking backwards rebuilds the selected attempt, then stepping forward restores it.
    await page.locator('#solveStep').evaluate((input: HTMLInputElement) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('#solveNext').click();
    assert.equal((await snapshot()).index, 1);
    await page.locator('#solvePrev').click();
    assert.equal((await snapshot()).index, 0);
    if (refusalIndex >= 0) {
      await page.locator('#solveNextRefusal').click();
      assert.equal((await snapshot()).index, refusalIndex);
      assert.equal((await snapshot()).event.type, 'refusal');
      assert.match(await page.locator('#solveDetails').innerText(), /"type": "refusal"/);
      const colours = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let pink = 0, yellow = 0, red = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
          if (r > 230 && g > 115 && g < 195 && b > 130 && b < 200) pink++;
          if (r > 230 && g > 200 && b > 80 && b < 150) yellow++;
          if (r > 130 && r > g * 1.5 && r > b * 1.3) red++;
        }
        return { pink, yellow, red };
      });
      assert.ok(colours.pink && colours.yellow && colours.red, `refusal overlays are drawn: ${JSON.stringify(colours)}`);
      await page.screenshot({ path: `${out}/placement.png`, fullPage: true });
    }
  }
  // Playback advances and pauses; camera operations affect only the drawing.
  await page.locator('#solveStep').evaluate((input: HTMLInputElement) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#solveSpeed').selectOption('120');
  await page.locator('#solvePlay').click();
  await page.waitForFunction(() => (window as any).mapLab.snapshot().placement.index >= 2);
  await page.locator('#solvePlay').click();
  assert.equal(await page.locator('#solvePlay').innerText(), 'Play');
  const paused = await snapshot();
  await page.waitForTimeout(100);
  assert.equal((await snapshot()).index, paused.index);
  const canvas = page.locator('#solveCanvas');
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const baseline = await pixels();
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  const zoomed = await pixels();
  assert.notEqual(zoomed, baseline, 'wheel zoom changes the drawing');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40);
  await page.mouse.up();
  assert.notEqual(await pixels(), zoomed, 'drag pans the drawing');
  await page.locator('#solveFit').click();
  assert.equal(await pixels(), baseline, 'fit restores the drawing');
  assert.equal((await snapshot()).index, paused.index);

  await page.locator('#worldTab').click();
  await page.locator('#seed').fill('placement-second');
  await page.locator('#solveTab').click();
  await page.locator('#solveRecord').click();
  await page.waitForFunction(() => (document.querySelector('#solveCancel') as HTMLButtonElement).disabled, null, { timeout: 60000 });
  assert.equal((await snapshot()).seed, 'placement-second', await page.locator('#solveStatus').innerText());
  assert.ok((await snapshot()).events > 0);
  assert.match(await page.locator('#solveRecipe').innerText(), /placement-second/);
  await page.locator('#solveRecord').click();
  await page.locator('#solveCancel').click();
  assert.match(await page.locator('#solveStatus').innerText(), /cancelled/i);
  assert.equal(await page.locator('#solveCancel').isDisabled(), true);
  assert.equal(await page.locator('#solveRecord').isEnabled(), true);
  assert.equal((await snapshot()).events, 0, 'cancel discards the previous recording');
  assert.equal((await snapshot()).seed, undefined);
  assert.deepEqual(errors, []);
  console.log('Placement browser acceptance passed.');
} finally {
  await browser?.close();
  await game.close();
  await rm(replayDir, { recursive: true, force: true });
}
