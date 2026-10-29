import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAIN_LIBRARIES } from '../../../map/chain.ts';
import { generateChainMap, mapViews } from '../../../map/macro/src/chain/map.ts';
import { REGION_TYPES_VERSION, buildRegion } from '../../../map/micro/region-types.ts';
import { composeRegions } from '../../../map/micro/compose.ts';
import { buildHutGeneration } from '../../../map/micro/strategies/hut.ts';
import { flattenDelegationResult } from '../../../map/micro/delegation-execute.ts';
import { discoverCordWitness } from '../../../map/micro/cord-witness.ts';
import { elementShapes } from '../../../map/micro/geometry.ts';
import { measureFill } from '../../../map/micro/fill.ts';
import { validatePortalReach } from '../../../map/micro/portals.ts';
import { hutApproaches } from '../../../tests/helpers/hut-cord-geometry.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDir = path.join(root, 'map/micro/strategies');
const temporaryParent = path.join(root, 'test-results');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
await mkdir(temporaryParent, { recursive: true });
const temporary = await mkdtemp(path.join(temporaryParent, 'issue-532-review-'));
try {
  let source = git('show', '5077596:map/micro/strategies/hut.ts');
  const oldCall = 'retainedBox: { x: site.x, y: site.y, ...site.house.demand.body },';
  assert.equal(source.split(oldCall).length, 2, 'expected one historical yard call');
  source = source.replace(oldCall, 'retainedBoxes: [{ x: site.x, y: site.y, ...site.house.demand.body }],');
  source = source.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_, prefix, specifier, suffix) => prefix + pathToFileURL(path.resolve(sourceDir, specifier)).href + suffix);
  const historicalPath = path.join(temporary, 'hut.ts');
  await writeFile(historicalPath, source);
  const { buildHutGeneration: oldBuild } = await import(pathToFileURL(historicalPath).href);
  let priorSource = git('show', '54e4967:map/micro/strategies/hut.ts');
  const priorCall = 'retainedBox: { x: sites[0]!.x, y: sites[0]!.y, ...sites[0]!.house.demand.body },';
  assert.equal(priorSource.split(priorCall).length, 2);
  priorSource = priorSource.replace(priorCall, '');
  priorSource = priorSource.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_, prefix, specifier, suffix) => prefix + pathToFileURL(path.resolve(sourceDir, specifier)).href + suffix);
  const priorPath = path.join(temporary, 'prior-hut.ts');
  await writeFile(priorPath, priorSource);
  const { buildHutGeneration: priorBuild } = await import(pathToFileURL(priorPath).href);
  const samples = [];
  for (const library of CHAIN_LIBRARIES) {
    const seed = `size-${library.zoneWidth}-1`;
    const params = { zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight, exitCount: 2,
      contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
    const map = generateChainMap(seed, params, library, 48, { version: REGION_TYPES_VERSION, build: buildRegion, compose: composeRegions });
    const defects = mapViews(map, composeRegions).report.defects;
    assert.equal(defects.length, 0, `${seed} map defects`);
    const huts = [];
    for (const result of map.results.filter(result => result.brief.type === 'hut')) {
      const brief = result.brief, before = oldBuild(brief), prior = priorBuild(brief), after = buildHutGeneration(brief);
      const houses = node => node.retained.elements.filter(e => /^hut-building(?:-\d+)?$/.test(e.label));
      const previous = houses(before), current = houses(after), flat = flattenDelegationResult(after);
      const priorHouses = houses(prior);
      assert.equal(previous.length, 1, `${seed} ${brief.id} historical house count`);
      assert.ok(current.length, `${seed} ${brief.id} has a house`);
      assert.deepEqual(current[0], previous[0], `${seed} ${brief.id} primary`);
      const blockers = flat.elements.flatMap(element => elementShapes(element));
      const approach = hutApproaches(after);
      assert.ok(approach && approach.houses.length === current.length, `${seed} ${brief.id} approaches`);
      const witness = discoverCordWitness(after.retained.brief, blockers, approach.terminals);
      assert.equal(witness.ok, true, `${seed} ${brief.id} doorstep: ${witness.reason}`);
      const reach = validatePortalReach({ ...flat.brief, blockers }, { search: 'thorough' });
      assert.deepEqual(reach.errors, [], `${seed} ${brief.id} portal reach`);
      const fill = measureFill(flat.brief, flat.elements);
      let sameSizePairs = 0, clonePairs = 0, sameSizeAllocationPairs = 0, differingAllocationPairs = 0;
      const roomCounts = {}, clonePairsByRooms = {};
      for (const trace of after.observerEvents.filter(t => current.some(h => h.label === t.label))) {
        const rooms = trace.design.spaces.length;
        roomCounts[rooms] = (roomCounts[rooms] ?? 0) + 1;
      }
      for (let i = 0; i < current.length; i++) for (let j = 0; j < i; j++) {
        const a = current[i], b = current[j];
        if (a.template.w !== b.template.w || a.template.h !== b.template.h) continue;
        sameSizePairs++;
        const ta = after.observerEvents.find(t => t.label === a.label), tb = after.observerEvents.find(t => t.label === b.label);
        if (JSON.stringify(a.template.parts) === JSON.stringify(b.template.parts)) {
          clonePairs++;
          const key = `${ta.design.spaces.length},${tb.design.spaces.length}`;
          clonePairsByRooms[key] = (clonePairsByRooms[key] ?? 0) + 1;
        }
        if (ta.design.spaces.length === tb.design.spaces.length) {
          sameSizeAllocationPairs++;
          if (JSON.stringify(ta.allocation) !== JSON.stringify(tb.allocation)) differingAllocationPairs++;
        }
      }
      huts.push({ id: brief.id, houses: current.length, envelopeCells: current.reduce((sum, h) => sum + h.template.w * h.template.h / brief.cellSize ** 2, 0),
        occupiedCells: fill.cells - fill.freeCells, primaryEqual: true, doorstepTerminals: approach.terminals.length,
        doorReach: true, portalErrors: reach.errors, sameSizePairs, clonePairs, sameSizeAllocationPairs, differingAllocationPairs,
        roomCounts, clonePairsByRooms, priorHouseCount: priorHouses.length,
        priorElementsEqual: JSON.stringify(priorHouses) === JSON.stringify(current) });
    }
    const total = key => huts.reduce((sum, hut) => sum + hut[key], 0);
    samples.push({ seed, zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight, defects,
      hutCount: huts.length, houseCount: total('houses'), envelopeCells: total('envelopeCells'), occupiedCells: total('occupiedCells'),
      sameSizePairs: total('sameSizePairs'), clonePairs: total('clonePairs'), sameSizeAllocationPairs: total('sameSizeAllocationPairs'),
      differingAllocationPairs: total('differingAllocationPairs'), hutsChangedFromPrior: huts.filter(h => !h.priorElementsEqual).length,
      roomCounts: huts.reduce((acc, h) => { for (const [k, v] of Object.entries(h.roomCounts)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
      clonePairsByRooms: huts.reduce((acc, h) => { for (const [k, v] of Object.entries(h.clonePairsByRooms)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}), huts });
  }
  const output = { node: process.version, head: git('rev-parse', 'HEAD'),
    sourceBlobs: Object.fromEntries(['map/micro/strategies/hut.ts', 'map/micro/yard-handoff.ts', 'map/micro/strategies/compound.ts'].map(p => [p, git('hash-object', p)])),
    historicalRevision: git('rev-parse', '5077596'),
    priorRevision: git('rev-parse', '54e4967'), priorScope: 'Prior hut module with current supporting modules; obsolete retainedBox argument removed, retaining the existing retainedBoxes array.',
    historicalScope: 'Historical hut module with current supporting modules; only its retainedBox argument is adapted to retainedBoxes: [retainedBox] for the current yard handoff.',
    measure: 'Envelope is rectangular house template area in cell equivalents; occupied is measureFill owned cells minus free cells across final combined geometry. Clone pairs compare template.parts; allocation pairs additionally require the same space count.', samples };
  await writeFile(new URL('./review-seeds.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(samples.map(({ huts, ...summary }) => summary), null, 2));
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(temporaryParent) + path.sep), 'temporary path stays in test-results');
  await rm(temporary, { recursive: true, force: true });
}
