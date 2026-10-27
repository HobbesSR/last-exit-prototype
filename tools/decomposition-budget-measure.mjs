// #605: bounded, read-only baseline for actual bundled block briefs and #598 witnesses.
// Run: node tools/decomposition-budget-measure.mjs [--out=PATH]
// Times are single in-process observations, not a benchmark or an exclusive dispatch cost.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { bundledLibrary, chainParams } from '../map/chain.ts';
import { placement } from '../map/macro/src/chain/placement.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { planBlock, buildBlock } from '../map/micro/strategies/block.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { analyzeRegion } from '../map/micro/decomposition/analysis.ts';
import { WorkBudget, WorkBudgetExceededError } from '../map/micro/decomposition/work-budget.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !/^--out=.+/.test(args[0]))) throw new Error('Usage: node tools/decomposition-budget-measure.mjs [--out=PATH]');
const hash = value => createHash('sha256').update(value).digest('hex');
const elapsed = fn => { const start = performance.now(), value = fn(); return { value, ms: performance.now() - start }; };
const cases = [];
// The first two seeds also appear in compound-delegation-audit. The third was
// found by inspecting actual placements for the largest authored footprint.
for (const [zoneWidth, zoneHeight, seed, width, height] of [
  [12, 6, 'issue330-before-12x6', 72, 24],
  [24, 12, 'issue330-before-24x12', 120, 36],
  [36, 18, 'issue605-0', 180, 48],
]) {
  const params = chainParams({ mode: 'game', zoneWidth, zoneHeight }), library = bundledLibrary(params);
  const layout = placement(seed, params, library);
  const briefs = mapViews({ layout, library, cellSize: 48, results: [] }).briefs.filter(b => b.type === 'block');
  const matches = briefs.filter(b => {
    const xs = b.cells.map(c => c.x), ys = b.cells.map(c => c.y);
    return Math.max(...xs) - Math.min(...xs) + 1 === width && Math.max(...ys) - Math.min(...ys) + 1 === height;
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!matches.length) throw new Error(`No ${width}x${height} block brief for ${seed}; inspect placement before choosing another sample.`);
  cases.push({ provenance: { kind: 'bundled-placement', seed, zoneWidth, zoneHeight, blockBriefCount: briefs.length,
    matchingBriefCount: matches.length, selection: `first ${width}x${height} brief by id`, cellSize: 48 }, brief: matches[0] });
}
for (const [shape, width, height] of [['neck', 24, 18], ['cross', 18, 48]]) {
  cases.push({ provenance: { kind: 'issue-598-region-example', shape, width, height, seed: 1 }, brief: regionExample({ type: 'block', shape, width, height, seed: 1 }) });
}
const rows = [];
for (const { provenance, brief } of cases) {
  const xs = brief.cells.map(c => c.x), ys = brief.cells.map(c => c.y);
  const plan = elapsed(() => planBlock(brief));
  const built = elapsed(() => buildBlock(brief)); // Includes a fresh plan and child dispatch; not an isolated dispatch timer.
  const work = new WorkBudget();
  const analysis = elapsed(() => {
    try { analyzeRegion(brief.cells, work); return { completed: true }; }
    catch (error) { if (!(error instanceof WorkBudgetExceededError)) throw error; return { completed: false }; }
  });
  if (provenance.kind === 'issue-598-region-example' && !plan.value.allocation) throw new Error(`${provenance.shape} no longer enters fallback`);
  rows.push({ provenance, id: brief.id, briefSha256: hash(JSON.stringify(brief)), cells: brief.cells.length,
    span: { width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 },
    portals: brief.portals.length, internalGuaranteed: (brief.internalGuaranteed ?? []).length,
    lots: plan.value.lots.length, lotTypes: plan.value.lots.map(lot => lot.type), fallbackEntered: !!plan.value.allocation,
    fallbackSearch: plan.value.allocation?.search ?? null, fallbackWork: plan.value.fallbackWork ?? null,
    analysisWork: { used: work.used, limit: work.limit, ...analysis.value }, elements: built.value.elements.length,
    elapsedMs: { planBlock: plan.ms, buildBlockIncludingPlanAndDispatch: built.ms, analysis: analysis.ms } });
}
const report = { node: process.version, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  trackedWorktreeDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  sourceSha256: Object.fromEntries(await Promise.all(['map/micro/strategies/block.ts', 'map/micro/decomposition/analysis.ts',
    'map/micro/decomposition/allocation.ts', 'map/micro/decomposition/context.ts', 'map/micro/decomposition/interfaces.ts',
    'map/micro/decomposition/work-budget.ts']
    .map(async path => [path, hash(await readFile(path))]))),
  limitations: 'Single sequential observations in one process; buildBlock includes planning, child building and delegation. Analysis is a direct SDK probe, not necessarily a production path. No timing subtraction. Placement and brief extraction are outside timings.', rows };
const output = JSON.stringify(report, null, 2) + '\n';
if (args.length) await writeFile(args[0].slice(6), output); else process.stdout.write(output);
