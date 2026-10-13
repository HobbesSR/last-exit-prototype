/** Paired, sequential macro-hut measurements for PR #336; no baseline recapture. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { buildRegion } from '../map/micro/region-types.ts';
import { buildHut, buildHutGeneration } from '../map/micro/strategies/hut.ts';

const prefix = `.timing-${randomUUID()}`;
const temporary = [];
async function historical(path, commit, replacements = []) {
  const url = new URL(`../${path.replace(/[^/]+$/, `${prefix}-${path.split('/').at(-1)}`)}`, import.meta.url);
  let source = execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
  for (const [from, to] of replacements) source = source.replace(from, to);
  temporary.push(url);
  await writeFile(url, source);
  return url;
}
try {
  const preparation = await historical('map/micro/delegation.ts', 'e6d0449');
  const execution = await historical('map/micro/delegation-execute.ts', 'e6d0449', [
    ["'./delegation.ts'", `'./${preparation.pathname.split('/').at(-1)}'`],
  ]);
  const reviewed = await historical('map/micro/strategies/hut.ts', 'e6d0449', [
    ["'../delegation-execute.ts'", `'../${execution.pathname.split('/').at(-1)}'`],
  ]);
  // The two hut revisions need separate filenames in the same strategy directory.
  const baselineUrl = new URL(`../map/micro/strategies/${prefix}-baseline.ts`, import.meta.url);
  temporary.push(baselineUrl);
  await writeFile(baselineUrl, execFileSync('git', ['show', '3b54da0:map/micro/strategies/hut.ts'], { encoding: 'utf8' }));
  const baseline = (await import(baselineUrl.href)).buildHut;
  const prior = (await import(reviewed.href)).buildHut;
  const cells = Array.from({ length: 172 * 172 }, (_, i) => ({ x: i % 172, y: Math.floor(i / 172) }));
  const portals = [];
  for (let i = 0; i + 2 <= 172; i += 3) portals.push(
    { id: `n${i}`, axis: 'h', x: i, y: 0, length: 2 }, { id: `s${i}`, axis: 'h', x: i, y: 172, length: 2 },
    { id: `w${i}`, axis: 'v', x: 0, y: i, length: 2 }, { id: `e${i}`, axis: 'v', x: 172, y: i, length: 2 });
  const brief = { id: 'field', seed: 3, type: 'hut', cellSize: 40, cells,
    zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals };
  const times = { houseOnly: [], reviewed: [], revised: [] };
  for (let i = 0; i < 3; i++) {
    const outputs = {};
    for (const [name, builder] of [['houseOnly', baseline], ['reviewed', prior], ['revised', buildHut]]) {
      const start = performance.now();
      outputs[name] = buildRegion(brief, { hut: builder });
      times[name].push(Number((performance.now() - start).toFixed(3)));
    }
    if (!isDeepStrictEqual(outputs.reviewed, outputs.revised)) throw Error('Review fixes changed macro-hut output.');
  }
  const node = buildHutGeneration(brief);
  console.log(JSON.stringify({ node: process.version, milliseconds: times, reviewOutputUnchanged: true,
    cells: cells.length, portals: portals.length, offers: node.offers.map(o => o.cells.length),
    accepted: node.preparation.children.length,
    acceptedOffers: node.preparation.children.map(child => ({ key: child.key, cells: child.brief.cells.length })) }, null, 2));
} finally {
  await Promise.all(temporary.map(url => unlink(url)));
}
