// Same-brief comparison of the default and opt-in block planners. No promotion gate.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { REGION_SHAPES, regionExample } from '../map/micro/region-examples.ts';
import { planBlock, buildBlock } from '../map/micro/strategies/block.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { measureFill } from '../map/micro/fill.ts';
import { elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { rect } from '../shared/shape.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const args = process.argv.slice(2), valid = /^(--quick|--no-timing|--out=.+)$/;
if (args.some(arg => !valid.test(arg)) || new Set(args.map(arg => arg.split('=')[0])).size !== args.length)
  throw new Error('Usage: node tools/block-planning-compare.mjs [--quick] [--no-timing] [--out=PATH]');
const quick = args.includes('--quick'), noTiming = args.includes('--no-timing');
const out = args.find(arg => arg.startsWith('--out='))?.slice(6);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));
const errorText = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error: errorText(error) }; } };
const variants = {
  default: { plan: brief => planBlock(brief), build: brief => buildBlock(brief) },
  sdkExperimental: { plan: brief => planBlock(brief, { planner: 'sdk-experimental' }),
    build: brief => buildBlock(brief, undefined, { planner: 'sdk-experimental' }) },
};
const portalKey = p => JSON.stringify([p.id, p.axis, p.x, p.y, p.length]);
const cases = [], mapSamples = [];
for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
  const recipe = { seed: '4217', mode: 'game', zoneWidth, zoneHeight };
  const { seed, ...params } = recipe;
  const views = mapViews(generate(seed, params), GAME_ENGINES.compose);
  const briefs = views.briefs.filter(brief => brief.type === 'block').sort((a, b) => a.id.localeCompare(b.id));
  mapSamples.push({ recipe, recipeSha256: digest(recipe), blockCount: briefs.length, mapDefects: views.report.defects });
  console.error(`Generated ${zoneWidth}x${zoneHeight}: ${briefs.length} block briefs`);
  for (const brief of quick ? briefs.slice(0, 1) : briefs)
    cases.push({ group: 'game', id: `${zoneWidth}x${zoneHeight}/${brief.id}`, recipe, brief });
}
for (const { id: shape } of REGION_SHAPES) for (const [width, height] of (quick ? [[24, 18]] : [[24, 18], [36, 30]])) {
  const recipe = { type: 'block', shape, width, height, seed: 1 };
  cases.push({ group: 'lab', id: `${shape}-${width}x${height}-1`, recipe, brief: regionExample(recipe) });
}
function geometry(brief, built, measureDensity = true, crosscheck = false) {
  const blockers = built.elements.flatMap(element => elementShapes(element));
  const result = { fillErrors: validateFillConstraints(brief, built.elements.flatMap(element => elementShapes(element, true))),
    portalErrors: validatePortalReach({ ...brief, blockers }).errors };
  if (measureDensity) {
    const size = brief.cellSize, free = new Set();
    for (const c of brief.cells) {
      const cell = rect(c.x * size, c.y * size, size, size);
      if (!blockers.some(shape => shapesOverlap(shape, cell))) free.add(`${c.x},${c.y}`);
    }
    const fill = { cells: brief.cells.length, freeCells: free.size };
    if (crosscheck) {
      const reference = measureFill(brief, built.elements);
      if (reference.cells !== fill.cells || reference.freeCells !== fill.freeCells)
        throw new Error(`occupancy differs from measureFill: ${JSON.stringify({ fill, reference })}`);
      result.occupancyCrosscheck = { matchesMeasureFill: true, cells: fill.cells, freeCells: fill.freeCells };
    }
    result.density = { fill, elements: built.elements.length, loot: built.loot.length };
  }
  return result;
}
function inspect(brief, api, crosscheck) {
  const p = attempt(() => api.plan(brief));
  if (p.error) return { usable: false, planError: p.error, buildError: null };
  const plan = p.value, children = [...plan.lots, plan.alleys];
  const result = { usable: true, planError: null, buildError: null, planSha256: digest(plan),
    experimental: plan.experimental ?? null, fallbackWork: plan.fallbackWork ?? null,
    allocation: plan.allocation ? { strategy: plan.allocation.strategy, pieces: plan.allocation.pieces.length } : null,
    lots: { count: plan.lots.length, cells: plan.lots.reduce((n, lot) => n + lot.cells.length, 0) },
    partitionErrors: validateBriefPartition(brief, children),
    parentPortalsRetained: brief.portals.every(p => plan.alleys.portals.some(q => portalKey(p) === portalKey(q))),
    children: children.map(child => {
      const built = attempt(() => buildRegion(child));
      if (built.error) return { id: child.id, type: child.type, buildError: built.error };
      const check = attempt(() => geometry(child, built.value, false));
      return { id: child.id, type: child.type, buildError: null, ...(check.error ? { inspectionError: check.error } : check.value) };
    }) };
  if (plan.experimental?.budgetExhausted || plan.experimental?.rejected || plan.fallbackWork?.budgetExhausted) result.usable = false;
  const built = attempt(() => api.build(brief));
  if (built.error) { result.usable = false; result.buildError = built.error; }
  else {
    result.buildSha256 = digest(built.value);
    const check = attempt(() => geometry(brief, built.value, true, crosscheck));
    if (check.error) { result.usable = false; result.inspectionError = check.error; }
    else result.parent = check.value;
  }
  return result;
}
function defects(result) {
  if (!result) return [];
  const errors = [];
  for (const key of ['planError', 'buildError', 'inspectionError']) if (result[key]) errors.push(`${key}: ${result[key]}`);
  if (result.experimental?.budgetExhausted) errors.push('experimental budget exhausted');
  if (result.experimental?.rejected) errors.push(`experimental rejected: ${result.experimental.rejected}`);
  if (result.fallbackWork?.budgetExhausted) errors.push('fallback budget exhausted');
  if (result.partitionErrors?.length) errors.push(`partition: ${JSON.stringify(result.partitionErrors)}`);
  if (result.parentPortalsRetained === false) errors.push('parent portals not retained');
  for (const [name, check] of [['parent', result.parent], ...(result.children ?? []).map(child => [child.id, child])]) {
    if (!check) continue;
    for (const key of ['buildError', 'inspectionError']) if (check[key]) errors.push(`${name} ${key}: ${check[key]}`);
    for (const key of ['fillErrors', 'portalErrors']) if (check[key]?.length) errors.push(`${name} ${key}: ${JSON.stringify(check[key])}`);
  }
  return errors;
}
const rows = cases.map(({ group, id, recipe, brief }, index) => {
  console.error(`Inspecting ${index + 1}/${cases.length}: ${id}`);
  const results = Object.fromEntries(Object.entries(variants).map(([name, api]) => {
    const inspected = attempt(() => inspect(brief, api, group === 'lab' && recipe.shape === 'rectangle' && recipe.width === 24 && recipe.height === 18));
    return [name, inspected.error ? { usable: false, inspectionError: inspected.error } : inspected.value];
  }));
  const foundDefects = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, defects(result)]));
  for (const [name, result] of Object.entries(results)) result.geometryValid = result.usable && foundDefects[name].length === 0;
  return { group, id, recipe, recipeSha256: digest(recipe), briefSha256: digest(brief), cells: brief.cells.length,
    portals: brief.portals.length, results, defects: foundDefects };
});
// Reversed cell order is sampled independently of timing and recorded even on errors.
const determinism = [];
for (const item of cases.filter((item, i) => cases.findIndex(other => other.group === item.group && (item.group === 'lab' ? other.recipe.shape === item.recipe.shape : other.recipe.zoneWidth === item.recipe.zoneWidth)) === i)) {
  const reversed = { ...item.brief, cells: [...item.brief.cells].reverse() };
  for (const [variant, api] of Object.entries(variants)) {
    const a = attempt(() => api.plan(item.brief)), b = attempt(() => api.plan(reversed));
    determinism.push({ id: item.id, variant, originalError: a.error ?? null, reversedError: b.error ?? null,
      originalSha256: a.error ? null : digest(a.value), reversedSha256: b.error ? null : digest(b.value),
      exactSame: a.error || b.error ? null : JSON.stringify(a.value) === JSON.stringify(b.value) });
  }
}
let timing = null;
if (!noTiming) {
  // Warm both variants first, then alternate their order across three paired trials.
  // Do not run alongside tests or other CPU-heavy work.
  for (const item of cases) for (const api of Object.values(variants)) attempt(() => api.plan(item.brief));
  timing = [];
  for (let trial = 0; trial < 3; trial++) {
    const order = trial % 2 ? ['sdkExperimental', 'default'] : ['default', 'sdkExperimental'];
    const measurements = {};
    for (const name of order) {
      const casesTimed = cases.map(item => {
        const start = performance.now(), planned = attempt(() => variants[name].plan(item.brief));
        const ms = performance.now() - start;
        return { id: item.id, group: item.group, ms, planError: planned.error ?? null,
          experimentalBudgetExhausted: !!planned.value?.experimental?.budgetExhausted,
          fallbackBudgetExhausted: !!planned.value?.fallbackWork?.budgetExhausted,
          rejected: planned.value?.experimental?.rejected ?? null };
      });
      const groups = Object.fromEntries(['game', 'lab'].map(group => {
        const entries = casesTimed.filter(item => item.group === group);
        return [group, { cases: entries.length, ms: entries.reduce((sum, item) => sum + item.ms, 0),
          thrownErrors: entries.filter(item => item.planError).length,
          experimentalBudgetExhausted: entries.filter(item => item.experimentalBudgetExhausted).length,
          fallbackBudgetExhausted: entries.filter(item => item.fallbackBudgetExhausted).length,
          rejected: entries.filter(item => item.rejected).length }];
      }));
      measurements[name] = { groups, cases: casesTimed };
    }
    timing.push({ trial: trial + 1, order, measurements });
  }
}
const summary = Object.fromEntries(Object.keys(variants).map(name => {
  const available = rows.filter(row => row.results[name].parent);
  return [name, { cases: rows.length, unusable: rows.filter(row => !row.results[name].usable).length,
    casesWithDefects: rows.filter(row => row.defects[name].length).length,
    defects: rows.reduce((n, row) => n + row.defects[name].length, 0),
    physicalDensity: { measuredCases: available.length,
      lotCells: available.reduce((n, row) => n + row.results[name].lots.cells, 0),
      lots: available.reduce((n, row) => n + row.results[name].lots.count, 0),
      elements: available.reduce((n, row) => n + row.results[name].parent.density.elements, 0),
      loot: available.reduce((n, row) => n + row.results[name].parent.density.loot, 0),
      cells: available.reduce((n, row) => n + row.results[name].parent.density.fill.cells, 0),
      freeCells: available.reduce((n, row) => n + row.results[name].parent.density.fill.freeCells, 0) } }];
}));
const pairedDensity = Object.fromEntries(['game', 'lab'].map(group => {
  const paired = rows.filter(row => row.group === group && Object.values(row.results).every(result => result.geometryValid && result.parent));
  const variantsSummary = Object.fromEntries(Object.keys(variants).map(name => [name, paired.reduce((total, row) => {
    const result = row.results[name], density = result.parent.density;
    total.lotCells += result.lots.cells; total.lots += result.lots.count;
    total.elements += density.elements; total.loot += density.loot;
    total.cells += density.fill.cells; total.freeCells += density.fill.freeCells;
    return total;
  }, { lotCells: 0, lots: 0, elements: 0, loot: 0, cells: 0, freeCells: 0 })]));
  return [group, { cases: paired.length, ids: paired.map(row => row.id), variants: variantsSummary }];
}));
const sourcePaths = git('ls-files', 'map/chain.ts', 'map/engines.ts', 'map/kernel', 'map/macro/src', 'map/macro/content', 'map/micro', 'shared/shape.ts', 'tools/block-planning-compare.mjs').split(/\r?\n/).filter(Boolean);
// The script may be untracked while under development.
if (!sourcePaths.includes('tools/block-planning-compare.mjs')) sourcePaths.push('tools/block-planning-compare.mjs');
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(path))])));
const report = { audit: 'block-planning-compare-1', createdAt: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), trackedStatus: git('status', '--porcelain', '--untracked-files=no'),
  sourceSha256, quick, mapSamples, summary, pairedDensity, determinism, timing, rows,
  limitations: 'Same current bundled libraries and same briefs, seed 4217 in three game sizes plus bounded region examples. Existing default defects are retained in each row. Child regions are built separately for their own fill and portal checks; parent checks inspect the final build. Density reports obstacle-cell occupancy only, excluding largest empty rectangles; the 24x18 rectangle lab case crosschecks occupancy against measureFill for both variants. Timing measures sequential planning only, including failures and diagnostic exhaustion, after warmup; it is not an exclusive benchmark. This sample is not exhaustive proof or a default-promotion decision.' };
const output = `${JSON.stringify(report, null, 2)}\n`;
if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(out, output); console.log(JSON.stringify({ out: resolve(out), summary })); }
else process.stdout.write(output);
