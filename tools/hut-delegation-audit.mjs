#!/usr/bin/env node
/** Reproducible before/after evidence for hut cover delegation (#330). */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { generate } from '../map/chain.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { checkMap } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/tools/engines.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { measureFill } from '../map/micro/fill.ts';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { planBlock } from '../map/micro/strategies/block.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_COMMIT = '3b54da0';
const SIZE = 40;

function options(argv) {
  const result = { seeds: 20, maps: false, diagnose: false, out: undefined };
  for (const arg of argv) {
    if (arg === '--maps') result.maps = true;
    else if (arg === '--diagnose') result.diagnose = true;
    else if (arg.startsWith('--seeds=')) result.seeds = Number(arg.slice(8));
    else if (arg.startsWith('--out=')) result.out = arg.slice(6);
    else throw new Error(`Unknown option ${arg}. Use --seeds=N --maps --diagnose --out=FILE.`);
  }
  if (!Number.isInteger(result.seeds) || result.seeds < 1 || result.seeds > 200)
    throw new Error('--seeds must be a whole number from 1 to 200.');
  if (!result.out && argv.some(arg => arg === '--out=')) throw new Error('--out needs a file path.');
  if (result.diagnose && !result.maps) throw new Error('--diagnose requires --maps.');
  return result;
}

const rectangle = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) => ({ x: n % w, y: Math.floor(n / w) }))
  .filter(({ x, y }) => keep(x, y));
const briefOf = (id, cells, portals, seed, lootChance = 0.5) => ({ id, seed, type: 'hut', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance, cells }], portals });

const CASES = [
  { id: 'small-6x6', cells: rectangle(6, 6), portals: [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }] },
  { id: 'rectangle-24x18', cells: rectangle(24, 18), portals: [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 },
  ] },
  { id: 'concave-yard-28x12', cells: rectangle(28, 12, (x, y) => y < 8 || x < 18), portals: [
    { id: 'north', axis: 'h', x: 2, y: 0, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
  ], lootChance: 0 },
  { id: 'ell-12x12', cells: rectangle(12, 12, (x, y) => y < 6 || x < 6), portals: [
    { id: 'east', axis: 'v', x: 12, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 12, length: 3 },
    { id: 'corner', axis: 'h', x: 7, y: 6, length: 4 },
  ] },
  { id: 'ring-14x14', cells: rectangle(14, 14, (x, y) => x < 5 || x >= 9 || y < 5 || y >= 9), portals: [
    { id: 'north', axis: 'h', x: 6, y: 0, length: 2 }, { id: 'hole', axis: 'v', x: 9, y: 6, length: 2 },
    { id: 'west', axis: 'v', x: 0, y: 10, length: 3 },
  ] },
];

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, min: null, median: null, mean: null, p95: null, max: null };
  const pick = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { samples: sorted.length, min: round(sorted[0]), median: round(pick(0.5)),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length), p95: round(pick(0.95)), max: round(sorted.at(-1)) };
}
const round = n => Number(n.toFixed(3));
const increment = (counts, key) => { if (key) counts[key] = (counts[key] ?? 0) + 1; };

function resultSummary(result, elapsedMs) {
  const fill = measureFill(result.brief, result.elements);
  const houseElements = result.elements.filter(element => element.template?.encloses).length;
  const coverElements = result.elements.filter(element => element.label.includes('/delegate/')).length;
  return { elapsedMs: round(elapsedMs), elements: result.elements.length, houseElements, coverElements,
    occupiedCells: fill.cells - fill.freeCells, freeCells: fill.freeCells,
    freeShare: round(fill.freeCells / Math.max(1, fill.cells)), gaps: fill.rectangles.length,
    largestGapCells: fill.largest ? fill.largest.w * fill.largest.h : 0,
    manifest: { structures: result.manifest.structures, obstacles: result.manifest.obstacles, gates: result.manifest.gates, loot: result.manifest.loot } };
}

function nodeDelegation(node) {
  const totals = { offers: node.offers?.length ?? 0, accepted: node.preparation?.children.length ?? 0,
    rejected: node.preparation?.rejected.length ?? 0, rejectionReasons: {}, stoppingReasons: {}, stoppingKinds: {} };
  const visit = at => {
    for (const rejected of at.preparation?.rejected ?? []) increment(totals.rejectionReasons, rejected.reason);
    if (at.fallbackReason) increment(totals.stoppingReasons, at.fallbackReason);
    if (at.fallbackKind) increment(totals.stoppingKinds, at.fallbackKind);
    for (const child of at.children ?? []) visit(child);
  };
  visit(node);
  return totals;
}

function tally(target, values) {
  for (const key of ['offers', 'accepted', 'rejected']) target[key] += values[key];
  for (const key of ['rejectionReasons', 'stoppingReasons', 'stoppingKinds'])
    for (const [reason, count] of Object.entries(values[key])) target[key][reason] = (target[key][reason] ?? 0) + count;
}

function auditPreparation(node) {
  if (!node.offers?.length) return { elapsedMs: 0, receiverCalls: 0, receiverAccepted: 0, receiverRejected: 0,
    matchesProduction: !node.preparation };
  const receiver = { calls: 0, accepted: 0, rejected: 0 }, cover = HUT_EXECUTION_REGISTRY.cover;
  const started = performance.now();
  const prepared = prepareDelegation(node.input, node.offers, { ...(node.policyData ?? {}), receiving(child, offer) {
    receiver.calls++;
    const reason = cover.receiving(child, offer);
    if (reason === null) receiver.accepted++; else receiver.rejected++;
    return reason;
  } });
  return { elapsedMs: round(performance.now() - started), receiverCalls: receiver.calls,
    receiverAccepted: receiver.accepted, receiverRejected: receiver.rejected,
    matchesProduction: isDeepStrictEqual(prepared, node.preparation) };
}

function tallyPreparation(target, value) {
  target.receiverCalls += value.receiverCalls;
  target.receiverAccepted += value.receiverAccepted;
  target.receiverRejected += value.receiverRejected;
  target.matchesProduction &&= value.matchesProduction;
  target.samples++;
}
const emptyDelegation = () => ({ offers: 0, accepted: 0, rejected: 0, rejectionReasons: {}, stoppingReasons: {}, stoppingKinds: {} });
const emptyPreparationAudit = () => ({ receiverCalls: 0, receiverAccepted: 0, receiverRejected: 0, matchesProduction: true, samples: 0 });

function baselineLoader() {
  const source = execFileSync('git', ['show', `${BASELINE_COMMIT}:map/micro/strategies/hut.ts`], { cwd: ROOT, encoding: 'utf8' });
  const path = resolve(ROOT, 'map/micro/strategies', `.hut-audit-baseline-${randomUUID()}.ts`);
  return { path, source, async load() {
    await writeFile(path, source, { flag: 'wx', encoding: 'utf8' });
    return import(`${pathToFileURL(path).href}?audit=${randomUUID()}`);
  } };
}

async function directAudit(seedCount) {
  const loader = baselineLoader();
  try {
    const baseline = await loader.load();
    const cases = [];
    for (const shape of CASES) {
      const beforeSamples = [], afterSamples = [];
      const delegation = emptyDelegation(), preparation = emptyPreparationAudit(), preparationTimes = [];
      for (let seed = 1; seed <= seedCount; seed++) {
        const brief = briefOf(shape.id, shape.cells, shape.portals, seed, shape.lootChance ?? 0.5);
        let started = performance.now();
        const before = baseline.buildHut(brief);
        beforeSamples.push(resultSummary(before, performance.now() - started));

        started = performance.now();
        const node = buildHutGeneration(brief);
        const afterElapsedMs = performance.now() - started;
        const after = flattenDelegationResult(node);
        afterSamples.push(resultSummary(after, afterElapsedMs));
        tally(delegation, nodeDelegation(node));
        const prep = auditPreparation(node);
        tallyPreparation(preparation, prep);
        preparationTimes.push(prep.elapsedMs);
        if (!prep.matchesProduction) throw new Error(`Preparation replay differs from production for ${shape.id}, seed ${seed}.`);
      }
      const fields = ['elapsedMs', 'elements', 'houseElements', 'coverElements', 'occupiedCells', 'freeCells', 'freeShare', 'gaps', 'largestGapCells'];
      const aggregate = samples => Object.fromEntries(fields.map(field => [field, summarize(samples.map(s => s[field]))]));
      cases.push({ id: shape.id, cells: shape.cells.length, portals: shape.portals.length, seeds: seedCount,
        before: aggregate(beforeSamples), after: aggregate(afterSamples), delegation,
        preparationAudit: { elapsedMs: summarize(preparationTimes), ...preparation } });
    }
    // Match tools/builder-fill.mjs's hut defaults exactly, including identity,
    // tier and loot chance, so its before/after counts are directly comparable.
    const cells = rectangle(24, 18), portals = [
      { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'east', axis: 'v', x: 24, y: 8, length: 2 },
    ];
    const fillBefore = [], fillAfter = [];
    for (let seed = 1; seed <= seedCount; seed++) {
      const brief = briefOf(`hut-${seed}`, cells, portals, seed, 0.3);
      brief.zones[0].tier = 1;
      fillBefore.push(measureFill(brief, baseline.buildHut(brief).elements, 3));
      fillAfter.push(measureFill(brief, flattenDelegationResult(buildHutGeneration(brief)).elements, 3));
    }
    const fillSummary = reports => {
      const sum = pick => reports.reduce((total, report) => total + pick(report), 0);
      return { built: reports.length, failed: 0,
        freeShare: round(sum(r => r.freeCells) / sum(r => r.cells)),
        gapsPerRegion: Number((sum(r => r.rectangles.length) / reports.length).toFixed(2)),
        gapCellsShare: round(sum(r => r.rectangles.reduce((a, g) => a + g.w * g.h, 0)) / sum(r => r.cells)),
        largestGapCells: Math.max(...reports.map(r => r.largest ? r.largest.w * r.largest.h : 0)) };
    };
    return { cases, fill: { width: 24, height: 18, min: 3, seeds: seedCount,
      before: fillSummary(fillBefore), after: fillSummary(fillAfter) } };
  } finally {
    await unlink(loader.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const mapSeeds = [
  { zoneWidth: 12, zoneHeight: 6, seed: 'issue330-before-12x6' },
  { zoneWidth: 24, zoneHeight: 12, seed: 'issue330-before-24x12' },
  { zoneWidth: 36, zoneHeight: 18, seed: 'issue330-before-36x18' },
];

async function mapAudit(diagnose) {
  const reports = [];
  for (const spec of mapSeeds) {
    const started = performance.now();
    const map = generate(spec.seed, { mode: 'game', zoneWidth: spec.zoneWidth, zoneHeight: spec.zoneHeight });
    const generationMs = round(performance.now() - started);
    const checkStarted = performance.now();
    const check = checkMap(map, { diagnose });
    const checkMs = round(performance.now() - checkStarted);
    const views = mapViews(map, GAME_ENGINES.compose), briefs = views.briefs;
    const topLevelTypes = {};
    for (const result of map.results) increment(topLevelTypes, result.brief.type);

    const planningStarted = performance.now();
    const hutBriefs = briefs.filter(brief => brief.type === 'hut');
    const blockBriefs = briefs.filter(brief => brief.type === 'block');
    const nestedHutBriefs = blockBriefs.flatMap(brief => planBlock(brief).lots.filter(lot => lot.type === 'hut'));
    const blockPlanningMs = round(performance.now() - planningStarted);
    const nodeCounts = emptyDelegation(), preparation = emptyPreparationAudit(), preparationTimes = [];
    let hutGenerationMs = 0;
    for (const brief of [...hutBriefs, ...nestedHutBriefs]) {
      const started = performance.now();
      const node = buildHutGeneration(brief);
      hutGenerationMs += performance.now() - started;
      tally(nodeCounts, nodeDelegation(node));
      const prep = auditPreparation(node);
      tallyPreparation(preparation, prep);
      preparationTimes.push(prep.elapsedMs);
      if (!prep.matchesProduction) throw new Error(`Preparation replay differs from production for ${brief.id}.`);
    }
    reports.push({ ...spec, generationMs, checkMs, diagnose, valid: check.valid,
      defects: check.defects.length, brokenPromises: check.brokenPromises?.length ?? null,
      tiles: map.layout.slots.length, setPieces: map.layout.setPieces.length, topLevelTypes,
      hutRegionsRebuilt: hutBriefs.length, blockRegionsPlanned: blockBriefs.length, nestedHutLotsRebuilt: nestedHutBriefs.length,
      hutBlockAudit: { blockPlanningMs, hutGenerationMs: round(hutGenerationMs),
        preparationAudit: { elapsedMs: summarize(preparationTimes), ...preparation }, delegation: nodeCounts } });
  }
  return reports;
}

async function main() {
  const opts = options(process.argv.slice(2));
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const workingTreeHutChanges = execFileSync('git', ['status', '--porcelain', '--', 'map/micro/strategies/hut.ts'],
    { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  const direct = await directAudit(opts.seeds);
  const maps = opts.maps ? await mapAudit(opts.diagnose) : undefined;
  const output = { audit: 'hut-delegation-1', baseline: { commit: BASELINE_COMMIT, source: 'git show commit:map/micro/strategies/hut.ts',
    note: 'The baseline hut strategy is loaded from the pinned source file; its unchanged relative imports resolve from a temporary sibling file. Current supporting modules come from this checkout.' },
    current: { commit: currentCommit, workingTreeHutChanges },
    seeds: opts.seeds, direct: direct.cases, fill: direct.fill,
    ...(maps ? { fullMaps: { baselineReference: 'test-results/330-before.md; generation only, no diagnostic', results: maps } } : {}) };
  const json = JSON.stringify(output, null, 2) + '\n';
  if (opts.out) {
    const path = resolve(process.cwd(), opts.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, 'utf8');
  } else process.stdout.write(json);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
