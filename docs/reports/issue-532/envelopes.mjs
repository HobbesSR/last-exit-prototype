import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAIN_LIBRARIES } from '../../../map/chain.ts';
import { generateChainMap } from '../../../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION, buildRegion } from '../../../map/micro/region-types.ts';
import { composeRegions } from '../../../map/micro/compose.ts';
import { buildHutGeneration } from '../../../map/micro/strategies/hut.ts';
import { flattenDelegationResult } from '../../../map/micro/delegation-execute.ts';
import { discoverCordWitness } from '../../../map/micro/cord-witness.ts';
import { elementShapes } from '../../../map/micro/geometry.ts';
import { hutApproaches } from '../../../tests/helpers/hut-cord-geometry.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDir = path.join(root, 'map/micro/strategies');
const temporaryParent = path.join(root, 'test-results');
await mkdir(temporaryParent, { recursive: true });
const temporary = await mkdtemp(path.join(temporaryParent, 'issue-532-historical-'));
try {
  const historicalSource = execFileSync('git', ['show', '5077596:map/micro/strategies/hut.ts'], { cwd: root, encoding: 'utf8' });
  const relocated = historicalSource.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_, prefix, specifier, suffix) => prefix + pathToFileURL(path.resolve(sourceDir, specifier)).href + suffix);
  const historicalPath = path.join(temporary, 'hut.ts');
  await writeFile(historicalPath, relocated);
  const { buildHutGeneration: oldBuild } = await import(pathToFileURL(historicalPath).href);
  const samples = [];
  for (const library of CHAIN_LIBRARIES) {
    const seed = `size-${library.zoneWidth}-1`;
    const params = { zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight, exitCount: 2,
      contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
    const map = generateChainMap(seed, params, library, 48, { version: REGION_TYPES_VERSION, build: buildRegion, compose: composeRegions });
    const huts = [];
    for (const result of map.results.filter(result => result.brief.type === 'hut')) {
      const brief = result.brief, before = oldBuild(brief), after = buildHutGeneration(brief);
      const houseElements = node => node.retained.elements.filter(e => e.label === 'hut-building' || /^hut-building-\d+$/.test(e.label));
      const previous = houseElements(before), current = houseElements(after);
      assert.equal(previous.length, 1, 'historical authored hut has one house');
      assert.ok(current.length);
      assert.deepEqual(current[0], previous[0], `Primary house differs: ${seed} ${brief.id}`);
      const envelope = houses => houses.reduce((sum, house) => sum + house.template.w * house.template.h / brief.cellSize ** 2, 0);
      const approach = hutApproaches(after);
      const witness = approach ? discoverCordWitness(after.retained.brief,
        flattenDelegationResult(after).elements.flatMap(e => elementShapes(e)), approach.terminals) : null;
      const doorReach = approach ? { ok: witness.ok, ...(witness.ok ? {} : { error: witness.reason }) } : { ok: current.length === 0, error: 'no house approaches' };
      assert.equal(doorReach.ok, true, `Doorstep access failed: ${seed} ${brief.id}`);
      huts.push({ id: brief.id, fillCells: brief.fillCells.length, beforeHouses: previous.length, afterHouses: current.length,
        beforeEnvelopeCells: envelope(previous), afterEnvelopeCells: envelope(current), primaryEqual: true, doorReach });
    }
    samples.push({ seed, zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight,
      fillCells: huts.reduce((sum, hut) => sum + hut.fillCells, 0),
      beforeEnvelopeCells: huts.reduce((sum, hut) => sum + hut.beforeEnvelopeCells, 0),
      afterEnvelopeCells: huts.reduce((sum, hut) => sum + hut.afterEnvelopeCells, 0), huts });
  }
  const output = { historicalRevision: '5077596', historicalScope: 'Historical hut module loaded with current supporting modules',
    measure: 'Sum of enclosing house template rectangle areas in cell equivalents; fillCells is the original brief fill mask. Neither measures total delegated cover or empty intent.', samples };
  await writeFile(new URL('./envelope-comparison.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(samples.map(({ huts, ...summary }) => ({ ...summary, huts: huts.length, doorFailures: huts.filter(h => !h.doorReach.ok).length }))));
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(temporaryParent) + path.sep), 'temporary path stays in test-results');
  await rm(temporary, { recursive: true, force: true });
}
