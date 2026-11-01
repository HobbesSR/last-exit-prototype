import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [inspectorArg = 'test-results/issue-716-frontage-inspector.html', outputArg = 'test-results/issue-716-frontage-browser'] = process.argv.slice(2);
const inspector = path.resolve(inspectorArg), output = path.resolve(outputArg);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
if (fs.existsSync(output)) throw new Error('Output directory already exists');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [], cases = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(pathToFileURL(inspector).href, { waitUntil: 'load', timeout: 120000 });
  const seeds = await page.locator('#seed option').allTextContents();
  assert.equal(seeds.length, 9);
  for (const seed of seeds) for (const panel of ['baseline', 'candidate']) for (const body of ['contestant', 'hunter']) {
    await page.selectOption('#seed', seed); await page.selectOption('#panel', panel); await page.selectOption('#body', body);
    await page.click('#full');
    const opts = await page.locator('#route option').allTextContents();
    assert.equal(opts.length, 151);
    const failedIndex = opts.findIndex(x => !x.includes('| complete |'));
    const zeroIndex = opts.findIndex(x => x.includes('| 0 hits'));
    if (failedIndex >= 0) await page.selectOption('#route', String(failedIndex));
    const failedInfo = failedIndex >= 0 ? await page.locator('#info').innerText() : null;
    if (zeroIndex >= 0) await page.selectOption('#route', String(zeroIndex));
    if (panel === 'candidate' && body === 'contestant' && /-1$/.test(seed))
      await page.screenshot({ path: path.join(output, `${seed}-full.png`) });
    await page.click('#eligible'); const eligibleInfo = await page.locator('#info').innerText();
    await page.click('#joined'); const joinedInfo = await page.locator('#info').innerText();
    if (panel === 'candidate' && body === 'contestant' && /-1$/.test(seed))
      await page.screenshot({ path: path.join(output, `${seed}-joined.png`) });
    cases.push({ seed, panel, body, routes: opts.length, failedIndex, zeroIndex,
      failedInfo: failedInfo?.slice(0, 900), eligible: !eligibleInfo.startsWith('No eligible'),
      joined: !joinedInfo.startsWith('No positive joined'), selection: joinedInfo.slice(0, 500) });
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ inspectorSha256: sha256(fs.readFileSync(inspector)),
    scriptSha256: sha256(fs.readFileSync(new URL(import.meta.url))), browserVersion: browser.version(), seeds, cases, errors }, null, 2));
  assert.equal(cases.length, 36);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: cases.length, failuresAvailable: cases.filter(c => c.failedIndex >= 0).length,
    eligible: cases.filter(c => c.eligible).length, joined: cases.filter(c => c.joined).length, errors }));
} finally { await browser.close(); }
