/** Focused Map Lab placement replay acceptance; run from the repository root. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tracePlacement } from '../placement-trace.ts';
import { CHAIN_LIBRARY } from '../../chain.ts';
import { placementSeams } from '../../macro/src/chain/partial-connectivity.ts';
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
  // Exercise all derived styles on a controlled canvas, including rare partial/conflict states.
  const synthetic = await page.evaluate(async () => {
    // @ts-expect-error Browser-served module is resolved by the lab server.
    const { drawPlacementSeams } = await import('/map/tools/lab/placement-seam-drawing.ts');
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 160;
    const ctx = canvas.getContext('2d')!; ctx.scale(10, 10);
    const kinds = ['internal-hint', 'blocked', 'guaranteed', 'unresolved', 'conflict', 'outside', 'same-region'];
    const seams = kinds.map((kind, i) => ({ key: `h:1,${i * 2 + 1}`, a: { x: 1, y: i * 2 + 1 }, b: { x: 10, y: i * 2 + 1 }, kind,
      lower: { state: 'placed', passability: 'not-passable-hint' }, upper: { state: 'placed', passability: 'passable' } }));
    const drawn = drawPlacementSeams(ctx, seams, 10, 'connectivity');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const has = (row: number, rgb: number[]) => {
      for (let y = row - 2; y <= row + 2; y++) for (let x = 10; x < 100; x++) {
        const j = (y * canvas.width + x) * 4;
        if (rgb.every((channel, i) => Math.abs(pixels[j + i]! - channel) < 5) && pixels[j + 3]! > 80) return true;
      }
      return false;
    };
    return { drawn, colours: [[232, 121, 198], [3, 7, 10], [215, 244, 212], [152, 167, 183], [255, 157, 77], [89, 102, 113]].map((rgb, i) => has(i * 20 + 10, rgb)), sameRegion: has(130, [89, 102, 113]) };
  });
  assert.equal(synthetic.drawn, 6);
  assert.deepEqual(synthetic.colours, [true, true, true, true, true, true], 'derived seam colours are rendered');
  assert.equal(synthetic.sameRegion, false);
  await page.locator('#seed').fill('sweep-66');
  await page.locator('#librarySource').selectOption('bundled');
  await page.locator('#solveTab').click();
  assert.equal(await page.locator('#solveSeed').inputValue(), 'sweep-66');
  assert.equal(await page.locator('#solveRecord').innerText(), 'Record placement');
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
  assert.equal(initial.attempt, 0, 'recording opens on the first attempt');
  const firstAttempt = trace.events.filter(event => event.attempt === 0);
  const placedEnd = trace.events.find(event => event.type === 'attempt-end' && event.outcome === 'placed');
  assert.ok(placedEnd && trace.layout, 'fixture eventually places a layout');
  const metadata = await page.locator('#solveMapSummary').innerText();
  assert.match(metadata, new RegExp(`${trace.layout.slots.length} slots`));
  assert.match(metadata, new RegExp(`${trace.layout.setPieces.length} set pieces`));
  assert.match(metadata, new RegExp(`${attempts.length} attempts`));
  assert.match(metadata, /complete trace/i);
  const placedEvents = trace.events.filter(event => event.attempt === placedEnd.attempt);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /set.piece.*fail/i);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /no fill/i);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /sweep-66/);
  await page.locator('#solveSpeed').selectOption('120');
  await page.locator('#solveStep').evaluate((input: HTMLInputElement, n: number) => { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles: true })); }, Math.max(0, firstAttempt.length - 2));
  await page.locator('#solvePlay').click();
  await page.waitForFunction(() => (window as any).mapLab.snapshot().placement.attempt === 1, null, { timeout: 5000 });
  await page.locator('#solvePlay').click();
  assert.equal((await snapshot()).attempt, 1, 'play continues into the next attempt');
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /sweep-66/);
  await page.locator('#solveAttempt').selectOption('0');
  await page.locator('#solveStep').evaluate((input: HTMLInputElement, n: number) => { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles: true })); }, firstAttempt.length - 1);
  await page.locator('#solveNext').click();
  assert.equal((await snapshot()).attempt, 1, 'step advances into the next attempt');
  assert.equal((await snapshot()).index, 0);
  await page.locator('#solvePrev').click();
  assert.equal((await snapshot()).attempt, 0, 'step back returns to the previous attempt');
  assert.equal((await snapshot()).index, firstAttempt.length - 1);
  await page.locator('#solveNextRefusal').click();
  assert.equal((await snapshot()).attempt, 1, 'refusal navigation crosses attempts');
  assert.equal((await snapshot()).event.type, 'refusal');
  await page.locator('#solveResult').click();
  const result = await snapshot();
  assert.equal(result.attempt, placedEnd.attempt);
  assert.equal(result.index, placedEvents.length - 1);
  assert.deepEqual(result.event, placedEnd);
  assert.equal(result.collapsed, trace.layout.slots.length);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /sweep-66/);
  const resultStart = placedEvents.find(event => event.type === 'attempt-start');
  assert.ok(resultStart && resultStart.type === 'attempt-start');
  const layoutByCoord = new Map(trace.layout.slots.map(slot => [`${slot.col},${slot.row}`, slot]));
  const completeTiles = new Map(resultStart.slots.map(slot => [slot.slot, layoutByCoord.get(`${slot.col},${slot.row}`)!]));
  const derivedSeams = placementSeams(CHAIN_LIBRARY, resultStart.slots, completeTiles);
  const counts = Object.fromEntries([...new Set(derivedSeams.map(seam => seam.kind))]
    .map(kind => [kind, derivedSeams.filter(seam => seam.kind === kind).length]));
  assert.deepEqual(result.seams.counts, counts, 'complete frame reports core seam classifications');
  assert.equal(result.seams.drawn, derivedSeams.length - (counts['same-region'] ?? 0));
  const hint = derivedSeams.find(seam => seam.kind === 'internal-hint');
  assert.ok(hint, 'complete fixture contains an internal hint');
  const position = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement, slots: { x: number; y: number }[]) => {
    const box = canvas.getBoundingClientRect();
    const minX = Math.min(...slots.map(s => s.x)) * 6, minY = Math.min(...slots.map(s => s.y)) * 6;
    const width = (Math.max(...slots.map(s => s.x)) + 1) * 6 - minX, height = (Math.max(...slots.map(s => s.y)) + 1) * 6 - minY;
    const scale = Math.max(.1, Math.min((box.width - 32) / width, (box.height - 32) / height));
    return { x: box.left + (box.width - width * scale) / 2 - minX * scale, y: box.top + (box.height - height * scale) / 2 - minY * scale, scale };
  }, resultStart.slots);
  await page.mouse.move(position.x + (hint.a.x + hint.b.x) / 2 * position.scale, position.y + (hint.a.y + hint.b.y) / 2 * position.scale);
  const hintDetail = await page.locator('#solveSeamDetail').innerText();
  assert.ok(hintDetail.includes(hint.key) && hintDetail.includes('lower') && hintDetail.includes('upper') && hintDetail.includes('derived: internal-hint'), hintDetail);
  assert.ok(hintDetail.includes(hint.lower.passability ?? 'unstated') && hintDetail.includes(hint.upper.passability ?? 'unstated'), hintDetail);
  const connectivityPixels = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.locator('#solveSeams').selectOption('authored');
  const authoredResult = await snapshot();
  assert.equal(authoredResult.seams.mode, 'authored');
  assert.equal(authoredResult.index, result.index);
  assert.equal(authoredResult.collapsed, result.collapsed);
  assert.equal(await page.locator('#solveMapSummary').innerText(), metadata);
  assert.notEqual(await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()), connectivityPixels, 'authored sides alter the rendering');
  await page.locator('#solveSeams').selectOption('connectivity');
  const pieceSlots = new Set(placedEvents.filter(event => event.type === 'set-piece-slot').map(event => event.slot));
  const fillSlots = resultStart.slots.filter(slot => !pieceSlots.has(slot.slot));
  assert.ok(fillSlots.length, 'successful attempt contains non-piece fill');
  const fillPixels = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement, slots: { x: number; y: number }[]) => {
    const box = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    const minX = Math.min(...slots.map(s => s.x)) * 6, minY = Math.min(...slots.map(s => s.y)) * 6;
    const width = (Math.max(...slots.map(s => s.x)) + 1) * 6 - minX;
    const height = (Math.max(...slots.map(s => s.y)) + 1) * 6 - minY;
    const scale = Math.max(.1, Math.min((box.width - 32) / width, (box.height - 32) / height));
    const x = (box.width - width * scale) / 2 - minX * scale, y = (box.height - height * scale) / 2 - minY * scale;
    const pixels = canvas.getContext('2d')!;
    return slots.map(slot => Array.from(pixels.getImageData(Math.round((x + (slot.x * 6 + .5) * scale) * ratio), Math.round((y + (slot.y * 6 + .5) * scale) * ratio), 1, 1).data));
  }, resultStart.slots);
  const fillIndices = new Set(fillSlots.map(slot => slot.slot));
  const paintedFill = resultStart.slots.flatMap((slot, i) => fillIndices.has(slot.slot) ? [fillPixels[i]!] : []);
  assert.ok(paintedFill.some(([r, g, b]) => {
    const high = Math.max(r!, g!, b!), low = Math.min(r!, g!, b!);
    return high > 70 && high - low > 35 && !(r === 49 && g === 84 && b === 126);
  }), 'non-piece slots have visible, chromatic fill colour');
  await page.screenshot({ path: `${out}/placement-result.png`, fullPage: true });
  await page.locator('#solveAttempt').selectOption('0');
  assert.equal((await snapshot()).attempt, 0, 'failed attempt remains selectable');
  assert.equal(await page.locator('#solveMapSummary').innerText(), metadata);
  assert.match(await page.locator('#solveRecipe').innerText(), /sweep-66/);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /set.piece.*fail/i);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /sweep-66/);
  assert.match(await page.locator('#solveAttempt').locator('option').first().innerText(), /sweep-66/);
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
        let cyan = 0, yellow = 0, red = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
          if (r < 100 && g > 180 && b > 220) cyan++;
          if (r > 230 && g > 200 && b > 80 && b < 150) yellow++;
          if (r > 130 && r > g * 1.5 && r > b * 1.3) red++;
        }
        return { cyan, yellow, red };
      });
      await page.screenshot({ path: `${out}/placement.png`, fullPage: true });
      assert.ok(colours.cyan && colours.yellow && colours.red, `refusal overlays are drawn: ${JSON.stringify(colours)}`);
    }
  }
  // At the end of pre-assignment, a shared edge within one piece is solid blue,
  // while its exterior still has an outline and hovering still identifies the tile.
  await page.locator('#solveAttempt').selectOption('0');
  const firstEvents = trace.events.filter(event => event.attempt === 0);
  const start = firstEvents.find(event => event.type === 'attempt-start');
  assert.ok(start && start.type === 'attempt-start');
  const assigned = firstEvents.filter(event => event.type === 'set-piece-slot');
  const checkpoint = firstEvents.reduce((last, event, i) => event.type === 'set-piece-slot' ? i : last, -1);
  assert.ok(checkpoint >= 0);
  const placed = new Map(assigned.map(event => [event.slot, event]));
  const coordinates = new Map(start.slots.map(slot => [`${slot.x},${slot.y}`, slot]));
  const pair = start.slots.flatMap(slot => {
    const tile = placed.get(slot.slot);
    return [[1, 0], [0, 1]].flatMap(([dx, dy]) => {
      const other = coordinates.get(`${slot.x + dx!},${slot.y + dy!}`);
      return tile && other && placed.get(other.slot)?.instance === tile.instance ? [{ slot, dx: dx!, dy: dy!, tile }] : [];
    });
  })[0];
  assert.ok(pair, 'fixture has adjacent slots in one set piece');
  await page.locator('#solveStep').evaluate((input: HTMLInputElement, n: number) => { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles: true })); }, checkpoint);
  await page.locator('#solveSeams').selectOption('none');
  const geometry = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement, slots: { x: number; y: number }[]) => {
    const box = canvas.getBoundingClientRect();
    const minX = Math.min(...slots.map(s => s.x)) * 6, minY = Math.min(...slots.map(s => s.y)) * 6;
    const width = (Math.max(...slots.map(s => s.x)) + 1) * 6 - minX;
    const height = (Math.max(...slots.map(s => s.y)) + 1) * 6 - minY;
    const scale = Math.max(.1, Math.min((box.width - 32) / width, (box.height - 32) / height));
    return { x: (box.width - width * scale) / 2 - minX * scale, y: (box.height - height * scale) / 2 - minY * scale, scale, left: box.left, top: box.top };
  }, start.slots);
  const seam = { x: pair.slot.x * 6 + (pair.dx ? 6 : 3), y: pair.slot.y * 6 + (pair.dy ? 6 : 3) };
  const seamPixel = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement, point: { x: number; y: number; scale: number; offsetX: number; offsetY: number }) => {
    const ratio = devicePixelRatio || 1;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round((point.x * point.scale + point.offsetX) * ratio), Math.round((point.y * point.scale + point.offsetY) * ratio), 1, 1).data);
  }, { ...seam, scale: geometry.scale, offsetX: geometry.x, offsetY: geometry.y });
  assert.ok(seamPixel.every((channel: number, i: number) => Math.abs(channel - [49, 84, 126, 255][i]!) <= 1), `shared set-piece seam remains solid blue: ${seamPixel}`);
  const boundary = start.slots.flatMap(slot => {
    const tile = placed.get(slot.slot);
    return [[1, 0], [0, 1]].flatMap(([dx, dy]) => {
      const other = coordinates.get(`${slot.x + dx!},${slot.y + dy!}`);
      const otherTile = other && placed.get(other.slot);
      return tile && otherTile && tile.instance !== otherTile.instance ? [{ slot, dx: dx!, dy: dy! }] : [];
    });
  })[0];
  assert.ok(boundary, 'fixture has adjacent distinct pieces');
  const boundaryPixel = await page.locator('#solveCanvas').evaluate((canvas: HTMLCanvasElement, point: { x: number; y: number; scale: number; offsetX: number; offsetY: number }) => {
    const ratio = devicePixelRatio || 1;
    const x = Math.round((point.x * point.scale + point.offsetX) * ratio), y = Math.round((point.y * point.scale + point.offsetY) * ratio);
    const pixels = canvas.getContext('2d')!.getImageData(x - 1, y - 1, 3, 3).data;
    return Array.from({ length: 9 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 4)));
  }, { x: boundary.slot.x * 6 + (boundary.dx ? 6 : 3), y: boundary.slot.y * 6 + (boundary.dy ? 6 : 3), scale: geometry.scale, offsetX: geometry.x, offsetY: geometry.y });
  assert.ok(boundaryPixel.some((pixel: number[]) => pixel.some((channel, i) => Math.abs(channel - seamPixel[i]!) > 2)), 'distinct set pieces retain their shared boundary');
  await page.mouse.move(geometry.left + geometry.x + (pair.slot.x * 6 + 3) * geometry.scale, geometry.top + geometry.y + (pair.slot.y * 6 + 3) * geometry.scale);
  assert.match(await page.locator('#solveHover').innerText(), new RegExp(`Slot ${pair.slot.slot} .*${pair.tile.instance}`));
  await page.screenshot({ path: `${out}/placement-piece.png`, fullPage: true });
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

  await page.locator('#solveSeed').fill('placement-second');
  assert.equal(await page.locator('#seed').inputValue(), 'placement-second');
  assert.equal(await page.evaluate(() => (window as any).mapLab.snapshot().busy), false, 'editing the recipe cancels an older World generation');
  await page.locator('#solveSeed').press('Enter');
  await page.waitForFunction(() => (document.querySelector('#solveCancel') as HTMLButtonElement).disabled, null, { timeout: 60000 });
  assert.equal((await snapshot()).seed, 'placement-second', await page.locator('#solveStatus').innerText());
  assert.ok((await snapshot()).events > 0);
  assert.match(await page.locator('#solveRecipe').innerText(), /placement-second/);
  assert.match(await page.locator('#solveAttempt').locator('option').first().innerText(), /placement-second/);
  const beforeRandom = await snapshot();
  const labelsBeforeRandom = await page.locator('#solveAttempt').locator('option').allTextContents();
  const recipeBeforeRandom = await page.locator('#solveRecipe').innerText();
  const metadataBeforeRandom = await page.locator('#solveMapSummary').innerText();
  await page.locator('#solveRandom').click();
  assert.match(await page.locator('#solveSeed').inputValue(), /^exit-/);
  assert.equal(await page.locator('#solveSeed').inputValue(), await page.locator('#seed').inputValue());
  assert.deepEqual(await snapshot(), beforeRandom, 'new seed edits the recipe without replacing the recording');
  assert.deepEqual(await page.locator('#solveAttempt').locator('option').allTextContents(), labelsBeforeRandom);
  assert.equal(await page.locator('#solveRecipe').innerText(), recipeBeforeRandom);
  assert.equal(await page.locator('#solveMapSummary').innerText(), metadataBeforeRandom);
  assert.match(await page.locator('#solveAttemptStatus').innerText(), /placement-second/);
  await page.locator('#solveRecord').click();
  await page.locator('#solveCancel').click();
  assert.match(await page.locator('#solveStatus').innerText(), /cancelled/i);
  assert.equal(await page.locator('#solveCancel').isDisabled(), true);
  assert.equal(await page.locator('#solveRecord').isEnabled(), true);
  assert.equal((await snapshot()).events, 0, 'cancel discards the previous recording');
  assert.equal((await snapshot()).seed, undefined);
  await page.locator('#solveSize').selectOption('24x12');
  await page.locator('#worldTab').click();
  assert.equal(await page.locator('#zoneSize').inputValue(), '24x12');
  assert.equal(await page.locator('#zoneWidth').inputValue(), '24');
  assert.equal(await page.locator('#zoneHeight').inputValue(), '12');
  await page.locator('#solveTab').click();
  await page.locator('#solveRecord').click();
  await page.locator('#solveCancel').click();
  assert.match(await page.locator('#solveRecipe').innerText(), /24 × 12.*diamond-24x12/);
  await page.setViewportSize({ width: 390, height: 900 });
  for (const tab of ['solveTab', 'placeablesTab']) {
    await page.locator(`#${tab}`).click();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(dimensions.width <= dimensions.viewport, `${tab} has no horizontal overflow: ${JSON.stringify(dimensions)}`);
  }
  assert.deepEqual(errors, []);
  console.log('Placement browser acceptance passed.');
} finally {
  await browser?.close();
  await game.close();
  await rm(replayDir, { recursive: true, force: true });
}
