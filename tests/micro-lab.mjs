// Developer preview acceptance: run directly with `node tests/micro-lab.mjs`.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { generate } from '../map/tools/core.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { briefFragment } from '../map/micro/brief-link.ts';
import { buildRegion } from '../map/micro/region-types.ts';

const replayDir = await mkdtemp(path.join(os.tmpdir(), 'last-exit-micro-lab-'));
await mkdir('test-results', { recursive: true });
const { server, base, browser } = await serveWithBrowser({ replayDir, profileSummary: false, devTools: 'all' });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(`${base}/dev/micro`);
  await page.waitForFunction(() => window.microLabDebug?.().result, null, { timeout: 15000 });
  // The explorer opens on the game depot; this suite retains the SDK example coverage.
  await page.getByLabel('Builder', { exact: true }).selectOption('open');
  assert.equal(errors.length, 0, errors.join('\n'));
  const initial = await page.evaluate(() => window.microLabDebug());
  assert.equal(initial.result.version, 'micro-1');
  assert.equal(initial.result.spec.bodyProfile, 'cell');
  assert.ok(initial.result.manifest.obstacles > 0, 'default builder emits geometry');
  assert.ok(initial.result.ports.length >= 2, 'required west/east ports resolve');
  for (const builder of ['open', 'depot', 'courtyard', 'ruins']) {
    await page.getByLabel('Builder').selectOption(builder);
    await page.getByRole('button', { name: 'Generate region' }).click();
    await page.waitForFunction(name => window.microLabDebug().result?.manifest.builder === name, builder);
    const generated = await page.evaluate(() => window.microLabDebug());
    assert.ok(generated.result.manifest.attempted > generated.result.manifest.rejected, `${builder} places content beyond the port boundary`);
    if (builder === 'depot' || builder === 'courtyard') assert.ok(generated.result.manifest.structures > 0, `${builder} has roofed structures`);
    if (builder === 'depot' || builder === 'courtyard') await page.screenshot({ path: `test-results/micro-lab-${builder}.png` });
  }
  await page.getByLabel('Seed').fill('0');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.spec.seed === 0);
  await page.getByLabel('Seed').fill('9961');
  await page.getByLabel('Density').fill('0.9');
  await page.getByLabel('Region shape').selectOption('hole');
  await page.getByLabel('Contestant north port').check();
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.spec.seed === 9961);
  const varied = await page.evaluate(() => window.microLabDebug());
  assert.notDeepEqual(varied.result.elements, initial.result.elements, 'seed and controls vary output');
  assert.ok(varied.result.ports.some(port => port.id === 'contestant-north'), 'optional north port resolves');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const downloadFile = await download;
  assert.match(downloadFile.suggestedFilename(), /^micro-region-9961\.json$/);
  assert.deepEqual(JSON.parse(await readFile(await downloadFile.path(), 'utf8')), varied.result, 'download preserves the generated artifact');
  const before = varied.avatar.x;
  await page.locator('#preview').focus();
  await page.keyboard.down('KeyD');
  await page.waitForFunction(x => window.microLabDebug().avatar.x !== x, before);
  await page.keyboard.up('KeyD');
  const after = await page.evaluate(() => window.microLabDebug().avatar.x);
  assert.notEqual(after, before, `walker should move or slide: ${before} -> ${after}`);
  await page.screenshot({ path: 'test-results/micro-lab.png' });
  await page.getByLabel('Builder', { exact: true }).selectOption('entry');
  assert.equal(await page.getByLabel('Ruin decay').isDisabled(), true, 'ruin-only control is disabled for entry layouts');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.entry?.points.length === 24);
  const entry = await page.evaluate(() => window.microLabDebug().result);
  assert.equal(entry.entry.shortfall, 0);
  const entryPoints = entry.entry.points;
  await page.getByLabel('Seed').fill('8128');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.spec.seed === 8128);
  assert.notDeepEqual((await page.evaluate(() => window.microLabDebug().result)).entry.points, entryPoints, 'entry seed changes visible position geometry');
  await page.getByLabel('Seed').fill(String(entry.spec.seed));
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(seed => window.microLabDebug().result?.spec.seed === seed, entry.spec.seed);
  await page.screenshot({ path: 'test-results/micro-lab-entry.png', fullPage: true });
  await page.locator('#import').setInputFiles({ name: 'entry.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(entry)) });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Loaded entry.json'));
  assert.deepEqual(await page.evaluate(() => window.microLabDebug().result), entry);
  const invalid = structuredClone(entry); invalid.entry.points[0].x = -999;
  await page.locator('#import').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Import rejected:'));
  assert.deepEqual(await page.evaluate(() => window.microLabDebug().result), entry, 'bad import preserves the previous valid region');
  await page.getByLabel('Builder', { exact: true }).selectOption('ruins');
  await page.getByLabel('Ruin decay').fill('0');
  await page.waitForFunction(() => window.microLabDebug().result?.spec.parameters.decay === 0);
  const intact = await page.evaluate(() => window.microLabDebug().result.elements);
  await page.screenshot({ path: 'test-results/micro-lab-decay-0.png', fullPage: true });
  await page.getByLabel('Ruin decay').fill('1');
  await page.waitForFunction(() => window.microLabDebug().result?.spec.parameters.decay === 1);
  assert.notDeepEqual(await page.evaluate(() => window.microLabDebug().result.elements), intact, 'decay auto-applies and changes physical geometry');
  await page.screenshot({ path: 'test-results/micro-lab-decay-1.png', fullPage: true });

  // A region type that builds from a design: its building views match the build in memory (56 L4).
  const views = ['Show design graph', 'Show allocation', 'Show spans', 'Show openings'];
  for (const view of views) assert.equal(await page.getByLabel(view).isDisabled(), true, `${view} is disabled for an example builder`);
  await page.getByLabel('Region shape').selectOption('rect');
  await page.getByLabel('Contestant north port').uncheck();
  await page.getByLabel('Seed').fill('4217');
  await page.getByLabel('Builder', { exact: true }).selectOption('region:hut');
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.type === 'hut' && window.microLabDebug().result.brief.seed === 4217);
  assert.equal(await page.getByLabel('Body scale').isDisabled(), true, 'region types are walked at cell proportions');
  for (const view of views) await page.getByLabel(view).check();
  const hut = await page.evaluate(() => window.microLabDebug());
  assert.equal(hut.result.version, 'region-2');
  assert.deepEqual(hut.promise, [], 'the hut keeps its portal promise');
  assert.equal(hut.buildings.length, 1);
  const [trace] = hut.buildings, building = hut.result.elements.find(element => element.label === trace.label);
  assert.ok(building, 'the trace names an element of the result');
  assert.deepEqual(trace.realization.template, building.template, 'the trace is what the element was realized from');
  assert.equal(Object.hasOwn(hut.result, 'buildings') || JSON.stringify(hut.result).includes('"design"'), false, 'designs are not stored (M30)');
  const placed = new Set(trace.realization.openings.map(opening => opening.connectionId));
  assert.deepEqual(hut.drawn, {
    allocation: { cells: trace.allocation.spaces.reduce((sum, space) => sum + space.cells.length, 0) },
    spans: { spans: trace.realization.boundaries.reduce((sum, boundary) => sum + boundary.spans.length, 0) },
    openings: { openings: building.template.parts.filter(part => part.part === 'gate' || part.kind === 'window').length },
    graph: { nodes: trace.design.spaces.length, edges: trace.design.connections.length, warnings: trace.design.connections.filter(c => !placed.has(c.id)).length },
  });
  // The example rectangle holds a three-space house (56 L5), with every asked connection met.
  assert.equal(hut.drawn.graph.nodes, 3);
  assert.equal(hut.drawn.allocation.cells, building.template.w * building.template.h / trace.cellSize ** 2);
  assert.match(await page.locator('#buildings').textContent(), /hut-building: 3 spaces, \d+ connections, \d+ openings/);
  assert.equal(await page.locator('#buildings .warning, #buildings .error').count(), 0);
  await page.screenshot({ path: 'test-results/micro-lab-hut.png' });
  // Seed 11's back room only joins the front through the other: the asked door is unmet guidance, a warning (M29).
  await page.getByLabel('Seed').fill('11');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.seed === 11);
  const missed = await page.evaluate(() => window.microLabDebug());
  assert.deepEqual(missed.promise, [], 'unmet guidance is not a broken promise');
  assert.equal(missed.drawn.graph.warnings, 1);
  assert.equal(await page.locator('#buildings .warning').count(), 1);
  assert.match(await page.locator('#buildings .warning').textContent(), /Guidance not met: link-1 \(door, front–back-1\)/);
  assert.equal(await page.locator('#buildings .error').count(), 0);
  await page.screenshot({ path: 'test-results/micro-lab-hut-unmet.png' });
  // A compound's ring is one design over its ring's cells, split into one element per space.
  await page.getByLabel('Seed').fill('1');
  await page.getByLabel('Builder', { exact: true }).selectOption('region:compound');
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.type === 'compound' && window.microLabDebug().result.brief.seed === 1);
  const compound = await page.evaluate(() => window.microLabDebug());
  assert.deepEqual(compound.promise, [], 'the compound keeps its portal promise');
  assert.deepEqual(compound.buildings.map(b => b.label), ['compound']);
  assert.equal(compound.drawn.graph.nodes, compound.result.manifest.rooms + compound.result.manifest.compoundGates);
  assert.equal(compound.drawn.graph.warnings, 0);
  await page.screenshot({ path: 'test-results/micro-lab-compound.png' });
  await page.getByLabel('Seed').fill('4217');
  await page.getByLabel('Builder', { exact: true }).selectOption('region:hut');
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.type === 'hut' && window.microLabDebug().result.brief.seed === 4217);
  for (const view of views) {
    await page.getByLabel(view).uncheck();
    const key = { 'Show design graph': 'graph', 'Show allocation': 'allocation', 'Show spans': 'spans', 'Show openings': 'openings' }[view];
    assert.equal(Object.hasOwn(await page.evaluate(() => window.microLabDebug().drawn), key), false, `${view} toggles off`);
  }
  // A block passes its lot's warehouse on, labelled as the lot's element.
  for (const view of views) await page.getByLabel(view).check();
  await page.getByLabel('Region shape').selectOption('l');
  await page.getByLabel('Seed').fill('2');
  await page.getByLabel('Builder', { exact: true }).selectOption('region:block');
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.type === 'block' && window.microLabDebug().result.brief.seed === 2);
  const block = await page.evaluate(() => window.microLabDebug());
  assert.deepEqual(block.buildings.map(b => b.label), ['lot-1/depot-warehouse-1']);
  assert.ok(block.result.elements.some(element => element.label === 'lot-1/depot-warehouse-1'));
  assert.equal(block.drawn.graph.nodes, 3);
  await page.screenshot({ path: 'test-results/micro-lab-block.png' });
  await page.getByLabel('Seed').fill('1');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.brief?.seed === 1);
  assert.equal((await page.evaluate(() => window.microLabDebug())).buildings.length, 0);
  assert.match(await page.locator('#scale-note').textContent(), /no building from a design/);
  await page.getByLabel('Builder', { exact: true }).selectOption('ruins');
  await page.waitForFunction(() => window.microLabDebug().result?.spec?.builder === 'ruins');
  assert.deepEqual((await page.evaluate(() => window.microLabDebug())).buildings, []);
  // A chain map's brief, opened by the Map Lab's link (20.5), builds the region the map stored,
  // and walks at the game's own scale. Houses and block-lot buildings are traced
  // under the authored seam layout and clear margins (20.6, 52).
  const chain = generate('last-exit-001'), briefs = mapViews(chain).briefs;
  for (const [type, map] of [['hut', chain], ['block', generate('last-exit-005')]]) {
    const brief = mapViews(map).briefs.find(b => b.type === type), stored = map.results.find(r => r.brief.id === brief.id);
    await page.goto(`${base}/dev/micro${await briefFragment(brief)}`);
    await page.waitForFunction(id => window.microLabDebug?.().imported === id, brief.id, { timeout: 15000 });
    const opened = await page.evaluate(() => window.microLabDebug());
    assert.deepEqual(opened.result, JSON.parse(JSON.stringify(stored)), `the micro lab builds the ${type} the map stored`);
    assert.deepEqual(opened.promise, [], `the chain ${type} keeps its portal promise`);
    assert.ok(opened.buildings.length > 0, `the chain ${type}'s buildings are traced`);
    assert.equal(await page.getByLabel('Body scale').isDisabled(), true, 'an imported brief walks at its own scale');
    assert.match(await page.locator('#status').textContent(), new RegExp(`Opened from a link\\. Region ${brief.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await page.screenshot({ path: `test-results/micro-lab-chain-${type}.png` });
  }
  // The authored delegation pilot is visible as a house and actual child cover.
  const yardCells = Array.from({ length: 28 * 12 }, (_, i) => ({ x: i % 28, y: Math.floor(i / 28) }))
    .filter(cell => cell.y < 8 || cell.x < 18);
  const pilotBrief = { id: 'concave-yard', seed: 1, type: 'hut', cellSize: 40, cells: yardCells,
    zones: [{ tier: 3, bonus: 0, lootChance: 0, cells: yardCells }],
    portals: [{ id: 'north', axis: 'h', x: 2, y: 0, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 3 }] };
  await page.goto(`${base}/dev/micro${await briefFragment(pilotBrief)}`);
  await page.waitForFunction(() => window.microLabDebug?.().imported === 'concave-yard');
  const pilot = await page.evaluate(() => window.microLabDebug());
  assert.deepEqual(pilot.result, JSON.parse(JSON.stringify(buildRegion(pilotBrief))));
  assert.ok(pilot.result.elements.some(element => element.template.encloses));
  assert.ok(pilot.result.elements.some(element => element.label.includes('/delegate/')));
  assert.equal(pilot.buildings.length, 1, 'cover does not manufacture building traces');
  await page.screenshot({ path: 'test-results/micro-lab-hut-delegation.png' });
  // The compound adopter keeps its traced ring/court and adds exterior cover.
  const compoundCells = Array.from({ length: 40 * 34 }, (_, i) => ({ x: i % 40, y: Math.floor(i / 40) }))
    .filter(cell => cell.y < 20 || cell.x < 20);
  const compoundYard = { id: 'compound-1', seed: 1, type: 'compound', cellSize: 40, cells: compoundCells,
    zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells: compoundCells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 40, y: 8, length: 2 }] };
  await page.goto(`${base}/dev/micro${await briefFragment(compoundYard)}`);
  await page.waitForFunction(() => window.microLabDebug?.().imported === 'compound-1');
  const compoundPilot = await page.evaluate(() => window.microLabDebug());
  assert.deepEqual(compoundPilot.result, JSON.parse(JSON.stringify(buildRegion(compoundYard))));
  assert.deepEqual(compoundPilot.promise, [], 'the browser-built compound keeps original portal access');
  assert.equal(compoundPilot.result.manifest.rooms, 15);
  assert.equal(compoundPilot.result.manifest.compoundGates, 2);
  assert.ok(compoundPilot.result.elements.some(element => element.label.includes('/delegate/')), 'exterior cover is built in the browser');
  assert.deepEqual(compoundPilot.buildings.map(trace => trace.label), ['compound']);
  for (const name of ['Show allocation', 'Show spans', 'Show openings', 'Show design graph'])
    await page.getByLabel(name, { exact: true }).uncheck();
  await page.screenshot({ path: 'test-results/micro-lab-compound-delegation.png', fullPage: true });
  // A saved brief imports as a file, as the Map Lab's "Save this region's brief" writes it.
  const lone = briefs.find(b => b.type === 'hut');
  await page.locator('#import').setInputFiles({ name: 'brief.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(lone)) });
  await page.waitForFunction(id => window.microLabDebug().imported === id, lone.id);
  assert.deepEqual((await page.evaluate(() => window.microLabDebug().result)), JSON.parse(JSON.stringify(chain.results.find(r => r.brief.id === lone.id))));
  // A region-2 result is rebuilt from its brief and compared by structure, so key order doesn't matter.
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)])) : value;
  const storedHut = chain.results.find(r => r.brief.id === lone.id);
  await page.locator('#import').setInputFiles({ name: 'result.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reordered(storedHut))) });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Loaded result.json'));
  assert.doesNotMatch(await page.locator('#status').textContent(), /differs/, 'a reordered but equal result is not reported as different');
  const altered = structuredClone(storedHut);
  if (altered.loot.length) altered.loot.pop();
  else altered.loot.push({ x: lone.cells[0].x * lone.cellSize, y: lone.cells[0].y * lone.cellSize, tier: 1 });
  await page.locator('#import').setInputFiles({ name: 'altered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(altered)) });
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Loaded altered.json'));
  assert.match(await page.locator('#status').textContent(), /differs from the file at result\.loot/);
  await page.getByLabel('Builder', { exact: true }).selectOption('ruins');
  await page.waitForFunction(() => window.microLabDebug().result?.spec?.builder === 'ruins' && window.microLabDebug().imported === null);
  await page.getByLabel('Body scale').selectOption('live');
  await page.getByRole('button', { name: 'Generate region' }).click();
  await page.waitForFunction(() => window.microLabDebug().result?.spec.bodyProfile === 'live');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'compact lab has no horizontal overflow');
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
  await rm(replayDir, { recursive: true, force: true });
}
