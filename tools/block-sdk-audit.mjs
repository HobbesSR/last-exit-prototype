// #580: retained same-brief comparison of the block SDK fallback and pinned legacy strategy.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { REGION_SHAPES, regionExample } from '../map/micro/region-examples.ts';
import { planBlock, buildBlock } from '../map/micro/strategies/block.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { measureFill } from '../map/micro/fill.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineRef = '872932e';
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/block.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
const sourceHashes = Object.fromEntries(await Promise.all([sourcePath, 'tools/block-sdk-audit.mjs']
  .map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'block-sdk-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = rows => rows.reduce((n, row) => n + row, 0);
const portalKey = p => JSON.stringify([p.id, p.axis, p.x, p.y, p.length]);
const errorText = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error: errorText(error) }; } };

try {
  const { planBlock: beforePlan, buildBlock: beforeBuild } = await import(pathToFileURL(baselineFile).href);
  const cases = [];
  for (const { id: shape } of REGION_SHAPES) for (const [width, height] of [[24, 18], [36, 30], [48, 44]])
    for (let seed = 1; seed <= 10; seed++) cases.push({ group: 'lab', id: `${shape}-${width}x${height}-${seed}`,
      brief: regionExample({ type: 'block', shape, width, height, seed }) });
  const mapSamples = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = '4217';
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const briefs = views.briefs.filter(brief => brief.type === 'block');
    console.error(`Generated ${zoneWidth}x${zoneHeight}: ${briefs.length} block briefs`);
    mapSamples.push({ seed, zoneWidth, zoneHeight, blocks: briefs.length, mapDefects: views.report.defects });
    for (const brief of briefs) cases.push({ group: 'game', id: `${zoneWidth}x${zoneHeight}/${brief.id}`, brief });
  }

  function inspect(brief, built, plan) {
    const blockers = built.elements.flatMap(element => elementShapes(element));
    const fill = measureFill(brief, built.elements);
    return { errors: {
      fill: validateFillConstraints(brief, built.elements.flatMap(element => elementShapes(element, true))),
      portal: validatePortalReach({ ...brief, blockers }).errors,
    }, density: { cells: fill.cells, freeCells: fill.freeCells, elements: built.elements.length,
      loot: built.loot.length, lotCells: count(plan.lots.map(lot => lot.cells.length)) } };
  }
  function compare({ group, id, brief }) {
    const oldPlan = attempt(() => beforePlan(brief)), newPlan = attempt(() => planBlock(brief));
    const row = { group, id, cells: brief.cells.length, portals: brief.portals.length,
      baselinePlanError: oldPlan.error ?? null, currentPlanError: newPlan.error ?? null };
    const failures = [];
    if (oldPlan.error || newPlan.error) {
      if (!oldPlan.error && newPlan.error) failures.push(`new plan error: ${newPlan.error}`);
      return { row, failures };
    }
    const before = oldPlan.value, after = newPlan.value;
    row.lots = { before: before.lots.length, after: after.lots.length };
    row.sdk = after.allocation ? { strategy: after.allocation.strategy, pieces: after.allocation.pieces.length } : null;
    row.planSame = same(before, after);
    const partition = validateBriefPartition(brief, [...after.lots, after.alleys]);
    const retained = brief.portals.every(p => after.alleys.portals.some(q => portalKey(p) === portalKey(q)));
    row.partitionErrors = partition;
    row.parentPortalsRetained = retained;
    if (partition.length) failures.push(`partition: ${partition.join(' | ')}`);
    if (!retained) failures.push('parent portal changed or absent from alleys');
    if (before.lots.length && !row.planSame) failures.push('successful legacy plan changed');
    if (after.allocation && (before.lots.length || after.lots.length > 1 || after.lots.some(lot => lot.cells.length > 144)))
      failures.push('SDK fallback exceeded single bounded lot');
    const beforeTraces = [], afterTraces = [];
    const oldBuilt = attempt(() => beforeBuild(brief, trace => beforeTraces.push(trace)));
    const newBuilt = attempt(() => buildBlock(brief, trace => afterTraces.push(trace)));
    row.baselineBuildError = oldBuilt.error ?? null;
    row.currentBuildError = newBuilt.error ?? null;
    if (!oldBuilt.error && newBuilt.error) failures.push(`new build error: ${newBuilt.error}`);
    if (oldBuilt.error || newBuilt.error) return { row, failures };
    row.buildSame = same(oldBuilt.value, newBuilt.value);
    row.tracesSame = same(beforeTraces, afterTraces);
    row.buildHashes = { before: digest(oldBuilt.value), after: digest(newBuilt.value) };
    if (before.lots.length && (!row.buildSame || !row.tracesSame)) failures.push('successful legacy build or trace changed');
    if (!row.buildSame) {
      const oldCheck = inspect(brief, oldBuilt.value, before), newCheck = inspect(brief, newBuilt.value, after);
      row.before = oldCheck;
      row.after = newCheck;
      row.delta = { elements: newCheck.density.elements - oldCheck.density.elements,
        freeCells: newCheck.density.freeCells - oldCheck.density.freeCells,
        loot: newCheck.density.loot - oldCheck.density.loot,
        lotCells: newCheck.density.lotCells - oldCheck.density.lotCells };
      row.newErrors = Object.fromEntries(Object.keys(oldCheck.errors).map(kind => [kind,
        oldCheck.errors[kind].length ? [] : newCheck.errors[kind]]));
      for (const [kind, errors] of Object.entries(row.newErrors)) if (errors.length)
        failures.push(`new ${kind} error where baseline passed: ${errors.join(' | ')}`);
    } else row.geometry = 'inherited by exact build equality';
    if (after.allocation?.pieces.length) {
      row.childPortalErrors = [...after.lots, after.alleys].map(child => {
        const prefix = `${child.id.slice(brief.id.length + 1)}/`;
        const blockers = newBuilt.value.elements.filter(element => element.label.startsWith(prefix))
          .flatMap(element => elementShapes(element));
        return { child: child.id, errors: validatePortalReach({ ...child, blockers }).errors };
      });
      for (const child of row.childPortalErrors) if (child.errors.length)
        failures.push(`${child.child} hunter portal error: ${child.errors.join(' | ')}`);
    }
    return { row, failures };
  }

  const rows = [], counterexamples = [];
  for (const item of cases) {
    const { row, failures } = compare(item);
    rows.push(row);
    if (rows.length % 20 === 0) console.error(`Compared ${rows.length}/${cases.length} briefs`);
    if (failures.length) {
      const issue = { id: row.id, failures };
      counterexamples.push(issue);
      console.error(JSON.stringify(issue));
    }
  }
  const changed = rows.filter(row => row.planSame === false);
  const changedBuilds = rows.filter(row => row.buildSame === false);
  const summary = { cases: rows.length, labCases: rows.filter(row => row.group === 'lab').length,
    gameCases: rows.filter(row => row.group === 'game').length,
    successfulLegacyPlans: rows.filter(row => row.lots?.before > 0).length,
    sdkSelections: rows.filter(row => row.sdk?.pieces).length,
    changedPlans: changed.length, changedBuilds: changedBuilds.length,
    densityDeltaChangedBuilds: { elements: count(changedBuilds.map(row => row.delta.elements)),
      freeCells: count(changedBuilds.map(row => row.delta.freeCells)),
      loot: count(changedBuilds.map(row => row.delta.loot)),
      lotCells: count(changedBuilds.map(row => row.delta.lotCells)) },
    baselinePlanErrors: rows.filter(row => row.baselinePlanError).length,
    baselineBuildErrors: rows.filter(row => row.baselineBuildError).length,
    currentPlanErrors: rows.filter(row => row.currentPlanError).length,
    currentBuildErrors: rows.filter(row => row.currentBuildError).length,
    counterexamples: counterexamples.length };
  const report = { audit: 'block-sdk-same-brief-1', baselineRef, baselineCommit, commit: git('rev-parse', 'HEAD'),
    createdAt: new Date().toISOString(), node: process.version, sourceHashes,
    currentSourceDirty: git('status', '--porcelain', '--', sourcePath), summary, mapSamples, counterexamples, rows,
    limits: 'Baseline block strategy is pinned to one source file; current geometry, child builders, library and engine are shared. Samples all six lab shapes at three sizes and seeds 1..10, plus block briefs from current-library game maps with seed 4217 at three zone sizes. Exact equality uses JSON serialization of plan, build and observer traces. Changed builds receive final hunter validatePortalReach, fill constraints, measureFill density and child portal checks on selected fallback lots. Unchanged builds inherit baseline geometry by exact result equality. Existing baseline errors are recorded on changed builds and only baseline-passing geometry is required to remain passing. This is a bounded correctness and density sample, not performance or exhaustive access proof.' };
  const out = resolve('docs/reports/issue-580/block-sdk-audit.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out, summary, changed: changed.map(row => ({ id: row.id, lots: row.lots,
    sdk: row.sdk, delta: row.delta, beforeErrors: row.before?.errors, afterErrors: row.after?.errors })) }));
  if (counterexamples.length) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
