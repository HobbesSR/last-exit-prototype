#!/usr/bin/env node
/** Same-input compound cord evidence (#647). Run with Node's TypeScript support. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { chainBrief, chainFixtures } from '../tests/helpers/chain-briefs.js';
import { compoundCordEvidence } from '../tests/helpers/compound-cord-geometry.js';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { generate } from '../map/chain.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { checkMap } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/tools/engines.ts';
import { planBlock } from '../map/micro/strategies/block.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'ccb28eb';
const cells = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) })).filter(c => keep(c.x, c.y));
const cases = [
  { name: 'small', cells: cells(6, 6), portals: [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }] },
  { name: 'rectangle', cells: cells(40, 34), portals: [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 }, { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }] },
  { name: 'concave', cells: cells(40, 34, (x, y) => y < 18 || x < 20), portals: [{ id: 'east', axis: 'v', x: 40, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 34, length: 4 }, { id: 'corner', axis: 'h', x: 24, y: 18, length: 6 }] },
  { name: 'holed', cells: cells(46, 46, (x, y) => x < 17 || x >= 29 || y < 17 || y >= 29), portals: [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 }, { id: 'hole', axis: 'v', x: 29, y: 20, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 34, length: 3 }] },
  { ...chainFixtures()[0], name: 'chain-internal-margins' },
];
function options(args) {
  const out = { seeds: 3, timing: false, maps: false, dir: 'test-results/compound-cords-review' };
  for (const arg of args) {
    if (arg === '--timing') out.timing = true;
    else if (arg === '--maps') out.maps = true;
    else if (arg.startsWith('--seeds=')) out.seeds = Number(arg.slice(8));
    else if (arg.startsWith('--out=')) out.dir = arg.slice(6);
    else if (arg.startsWith('--render-from=')) out.renderFrom = arg.slice(14);
    else if (arg.startsWith('--compare-from=')) out.compareFrom = arg.slice(15);
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.seeds) || out.seeds < 1 || out.seeds > 50 || !out.dir || out.renderFrom === '' || out.compareFrom === '') throw Error('Use --seeds=1..50, --out=DIRECTORY, --timing, --maps, --render-from=FILE, --compare-from=FILE.');
  return out;
}
const brief = (c, seed) => chainBrief({ ...c, id: `cord-${c.name}`, type: 'compound', seed });
const mapSpecs = [
  { zoneWidth: 12, zoneHeight: 6, seed: 'issue330-before-12x6' },
  { zoneWidth: 24, zoneHeight: 12, seed: 'issue330-before-24x12' },
  { zoneWidth: 36, zoneHeight: 18, seed: 'issue330-before-36x18' },
];
function productionInputs() {
  const inputs = [], maps = [];
  for (const spec of mapSpecs) {
    process.stdout.write(`Generating map ${spec.seed} (${spec.zoneWidth}x${spec.zoneHeight})...\n`);
    const map = generate(spec.seed, { mode: 'game', zoneWidth: spec.zoneWidth, zoneHeight: spec.zoneHeight });
    const check = checkMap(map);
    const briefs = mapViews(map, GAME_ENGINES.compose).briefs;
    const candidates = [
      ...briefs.filter(b => b.type === 'compound').map(b => ({ brief: b, location: 'top-level' })),
      ...briefs.filter(b => b.type === 'block').flatMap(block => planBlock(block).lots
        .filter(b => b.type === 'compound').map(b => ({ brief: b, location: 'block-lot', block: block.id }))),
    ];
    const unique = new Map();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.brief.id);
      if (previous && !isDeepStrictEqual(previous.brief, candidate.brief))
        throw Error(`Different compound briefs share id ${candidate.brief.id} in ${spec.seed}`);
      if (!previous) unique.set(candidate.brief.id, candidate);
    }
    const collected = [...unique.values()];
    maps.push({ ...spec, valid: check.valid, defects: check.defects, candidates: candidates.length,
      uniqueCompounds: collected.length, topLevel: collected.filter(c => c.location === 'top-level').length,
      blockLots: collected.filter(c => c.location === 'block-lot').length });
    process.stdout.write(`${spec.seed}: ${collected.length} unique compounds (${candidates.length} candidates); auditing all.\n`);
    for (const candidate of collected) inputs.push({ name: `${spec.seed} / ${candidate.brief.id}`,
      seed: candidate.brief.seed, brief: candidate.brief, source: { map: spec.seed, location: candidate.location, ...(candidate.block ? { block: candidate.block } : {}) } });
  }
  return { inputs, maps };
}
const ring = result => result.elements.filter(e => e.label.startsWith('compound-'));
function geometry(result, combinedBlockers) {
  const placed = result.elements.flatMap(e => elementShapes(e, true));
  const blockers = combinedBlockers ?? result.elements.flatMap(e => elementShapes(e));
  return { fill: validateFillConstraints(result.brief, placed), reach: validatePortalReach({ ...result.brief, blockers }, { search: 'thorough' }).errors };
}
function inspect(node) {
  const owners = [], failures = [];
  const wholeResult = flattenDelegationResult(node);
  const combinedBlockers = wholeResult.elements.flatMap(e => elementShapes(e));
  function visit(n) {
    const g = geometry(n.retained, combinedBlockers);
    owners.push({ id: n.retained.brief.id, cells: n.retained.brief.cells, geometry: g });
    if (g.fill.length || g.reach.length) failures.push({ scope: n.retained.brief.id, ...g });
    if (n.preparation) {
      const errors = validateBriefPartition(n.input, [n.retained.brief, ...(n.children ?? []).map(c => c.input)]);
      if (errors.length) failures.push({ scope: `${n.input.id} partition`, errors });
    }
    for (const child of n.children ?? []) visit(child);
  }
  visit(node);
  const whole = geometry(wholeResult, combinedBlockers);
  if (whole.fill.length || whole.reach.length) failures.push({ scope: 'whole', ...whole });
  return { owners, whole, failures };
}
// Ring-box footprint uses the realized building envelope, in cell coordinates. Count
// only original cells whose interiors intersect it; boundary contact is not area.
function retention(brief, node) {
  const ring = node.retained.elements.filter(e => e.label.startsWith('compound-'));
  const size = brief.cellSize;
  const box = ring.length ? { x: Math.min(...ring.map(e => e.x)), y: Math.min(...ring.map(e => e.y)),
    right: Math.max(...ring.map(e => e.x + e.template.w)), bottom: Math.max(...ring.map(e => e.y + e.template.h)) } : null;
  const inBox = c => box && c.x * size < box.right && (c.x + 1) * size > box.x && c.y * size < box.bottom && (c.y + 1) * size > box.y;
  const original = brief.cells.length, retained = node.retained.brief.cells.length;
  const ringCells = brief.cells.filter(inBox).length, retainedRingCells = node.retained.brief.cells.filter(inBox).length;
  const originalYard = original - ringCells, retainedYard = retained - retainedRingCells;
  return { originalCells: original, retainedCells: retained, ringCells, retainedRingCells, originalYardCells: originalYard,
    retainedYardCells: retainedYard, retainedFraction: original ? retained / original : null,
    retainedYardFraction: originalYard ? retainedYard / originalYard : null };
}
function counts(node) {
  return { children: node.children?.length ?? 0,
    offeredCells: (node.offers ?? []).reduce((n, offer) => n + offer.cells.length, 0),
    transferredCells: node.input.cells.length - node.retained.brief.cells.length };
}
function aggregate(records, side) {
  const available = records.map(r => side === 'previousReview' ? r.previousReview : counts(r[side].generation)).filter(Boolean);
  return { cases: available.length, childCount: available.reduce((n, c) => n + c.children, 0),
    regionsWithChildren: available.filter(c => c.children > 0).length,
    offeredCells: available.reduce((n, c) => n + c.offeredCells, 0),
    transferredCells: available.reduce((n, c) => n + c.transferredCells, 0) };
}
function distributions(records) {
  const distribution = (side, field) => {
    const items = records.filter(r => Number.isFinite(r[side].retention[field]))
      .map(r => ({ value: r[side].retention[field], name: r.name, seed: r.seed, source: r.source }))
      .sort((a, b) => a.value - b.value);
    const n = items.length;
    return { samples: n, min: n ? items[0].value : null,
      median: n ? (items[Math.floor((n - 1) / 2)].value + items[Math.floor(n / 2)].value) / 2 : null,
      max: n ? items[n - 1].value : null, minimumCase: n ? items[0] : null };
  };
  return Object.fromEntries(['before', 'after'].map(side => [side, {
    retainedFraction: distribution(side, 'retainedFraction'), retainedYardFraction: distribution(side, 'retainedYardFraction'),
  }]));
}
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function shapeSvg(s, color) {
  if (s.kind === 'rect') return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${color}"/>`;
  if (s.kind === 'circle') return `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${color}"/>`;
  if (s.kind === 'polygon') return `<polygon points="${s.points.map(p => `${s.x + p.x},${s.y + p.y}`).join(' ')}" fill="${color}"/>`;
  throw Error(`Unknown shape ${s.kind}`);
}
function panel(b, result, owners, cords) {
  const size = b.cellSize, xs = b.cells.map(c => c.x), ys = b.cells.map(c => c.y);
  const x = Math.min(...xs) * size - size, y = Math.min(...ys) * size - size;
  const w = (Math.max(...xs) - Math.min(...xs) + 3) * size, h = (Math.max(...ys) - Math.min(...ys) + 3) * size;
  const palette = ['#e8e8df', '#b6d8bd', '#b4c9eb', '#f2d3a1', '#d3b6e0'];
  let svg = `<svg viewBox="${x} ${y} ${w} ${h}" role="img">`;
  owners.forEach((o, i) => { for (const c of o.cells) svg += `<rect x="${c.x * size}" y="${c.y * size}" width="${size}" height="${size}" fill="${palette[i % palette.length]}" stroke="#aaa" stroke-width="1"/>`; });
  for (const e of result.elements) for (const s of elementShapes(e, true)) svg += shapeSvg(s, e.label.startsWith('compound-') ? '#7a3830' : '#365b45');
  for (const p of b.portals) svg += `<line x1="${p.x * size}" y1="${p.y * size}" x2="${(p.x + (p.axis === 'h' ? p.length : 0)) * size}" y2="${(p.y + (p.axis === 'v' ? p.length : 0)) * size}" stroke="#d518ad" stroke-width="8"/>`;
  if (cords) {
    for (const [paths, color, dashed] of [[cords.initialPaths, '#d18b00', true], [cords.finalPaths ?? [], '#1264b7', false]])
      for (const path of paths) svg += `<polyline points="${path.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="5" ${dashed ? 'stroke-dasharray="12 8"' : ''}/>`;
    for (const p of cords.terminals) svg += `<circle cx="${p.x}" cy="${p.y}" r="8" fill="#1264b7"/>`;
  }
  return svg + '</svg>';
}
function renderReport(report) {
  const panels = report.records.map(r => `<section><h2>${esc(r.name)} - seed ${esc(r.seed)}</h2><div class="pair"><figure><figcaption>Before (${esc(report.baseline.commit)})</figcaption>${panel(r.brief, r.before.result, r.before.owners)}</figure><figure><figcaption>After</figcaption>${panel(r.brief, r.after.result, r.after.owners, r.cords)}</figure></div><p>After overlays: dashed amber is the initial full ring-box route; blue is independently rediscovered final access, dots are gate approaches. Displaced initial routes: ${esc(r.cords?.initialReady === false ? `unavailable (${r.cords.initialFailure})` : (r.cords?.displaced?.join(', ') || 'none'))}. Checks: ${esc(JSON.stringify(r.checks))}; geometry failures before ${r.before.failures.length}, after ${r.after.failures.length}. Retention before/after: ${esc(JSON.stringify([r.before.retention, r.after.retention]))}. See JSON for details.</p></section>`);
  return `<!doctype html><meta charset="utf-8"><title>Compound cord audit</title><style>body{font:16px system-ui;margin:2em}section{border-top:1px solid #aaa}.pair{display:flex;gap:1em}figure{margin:0;flex:1}svg{width:100%;max-height:500px;background:#fff}figcaption{font-weight:bold}p,code{overflow-wrap:anywhere}</style><h1>Compound cord audit</h1><p>Same brief and seed. Cell colours indicate owners; brown geometry is the ring, green is cover, magenta marks external portals. ${report.comparisonSource ? 'Matching baseline geometry is historical and was not rerun; other baseline cases use current supporting modules.' : 'Baseline uses current supporting modules.'} Raw results and diagnostic errors: <a href="results.json">results.json</a>.</p>${report.diagnosticCounts ? `<h2>Yard candidate and fallback diagnostics</h2><p><code>${esc(JSON.stringify(report.diagnosticCounts))}</code></p>` : ''}${report.retentionDistributions ? `<h2>Retained ownership and yard distributions</h2><p><code>${esc(JSON.stringify(report.retentionDistributions))}</code></p>` : ''}${report.maps ? `<h2>Production maps</h2><p>All unique top-level compounds and block lots are shown below. Counts, map defects and uptake: <code>${esc(JSON.stringify(report.maps))}</code></p>` : ''}${panels.join('')}`;
}
async function main() {
  const opts = options(process.argv.slice(2)), dir = resolve(ROOT, opts.dir);
  if (opts.renderFrom) {
    if (opts.maps || opts.timing || opts.compareFrom) throw Error('--render-from cannot be combined with --maps, --timing or --compare-from.');
    const inputPath = resolve(ROOT, opts.renderFrom);
    const outputPath = resolve(dir, 'results.json');
    const bytes = await readFile(inputPath);
    const raw = (inputPath.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
    const report = JSON.parse(raw);
    if (!Array.isArray(report.records)) throw Error('Report has no records.');
    await mkdir(dir, { recursive: true });
    if (inputPath !== outputPath) await writeFile(outputPath, raw);
    await writeFile(resolve(dir, 'index.html'), renderReport(report));
    process.stdout.write(`Rendered ${dir} from ${inputPath} without rebuilding.\n`);
    return;
  }
  let comparison, comparisonSource;
  if (opts.compareFrom) {
    const inputPath = resolve(ROOT, opts.compareFrom), bytes = await readFile(inputPath);
    comparison = JSON.parse((inputPath.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
    if (!Array.isArray(comparison.records)) throw Error('Comparison report has no records.');
    comparisonSource = { path: opts.compareFrom, sha256: createHash('sha256').update(bytes).digest('hex'),
      contentCommit: comparison.currentCommit, baselineCommit: comparison.baseline?.commit, reuseCount: 0,
      note: 'Matching original before geometry and failures are historical report observations, not rerun; snapshot checks are current.' };
  }
  const source = execFileSync('git', ['show', `${BASELINE}:map/micro/strategies/compound.ts`], { cwd: ROOT, encoding: 'utf8' });
  const path = resolve(ROOT, 'map/micro/strategies', `.compound-cord-baseline-${randomUUID()}.ts`);
  try {
    await writeFile(path, source, { flag: 'wx' });
    const old = await import(`${pathToFileURL(path).href}?${randomUUID()}`);
    const inputs = cases.flatMap(c => Array.from({ length: opts.seeds }, (_, i) => ({ name: c.name, seed: i + 1, brief: brief(c, i + 1) })));
    const production = opts.maps ? productionInputs() : undefined;
    if (production) inputs.push(...production.inputs);
    const records = [];
    for (const input of inputs) {
      const yardDiagnostics = [];
      const matched = comparison?.baseline?.commit === BASELINE
        ? comparison.records.find(r => isDeepStrictEqual(r.brief, input.brief)) : undefined;
      if (matched) comparisonSource.reuseCount++;
      const before = matched ? matched.before.generation : old.buildCompoundGeneration(input.brief);
      const after = buildCompoundGeneration(input.brief, { observeYard: report => yardDiagnostics.push(report) });
      const beforeResult = matched ? matched.before.result : flattenDelegationResult(before), afterResult = flattenDelegationResult(after);
      const prior = matched ? { owners: matched.before.owners, whole: matched.before.whole, failures: matched.before.failures } : inspect(before);
      const current = inspect(after), checks = {};
      let previousReview;
      if (matched) {
        const previous = matched.after.generation, previousResult = matched.after.result;
        checks.previousReviewFullSnapshot = isDeepStrictEqual(previousResult, delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(previous)))));
        try {
          delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(previous, { omitResults: true }))), COMPOUND_EXECUTION_REGISTRY);
          checks.previousReviewOmittedRefused = false;
        } catch (error) { checks.previousReviewOmittedRefused = String(error).includes('compound'); }
        previousReview = { ...counts(previous), retention: matched.after.retention };
      }
      const cords = compoundCordEvidence(after, afterResult);
      checks.actualGateAccess = cords ? cords.finalAccess : ring(afterResult).length === 0;
      checks.ringUnchanged = isDeepStrictEqual(ring(beforeResult), ring(afterResult));
      checks.deterministic = isDeepStrictEqual(after, buildCompoundGeneration(input.brief));
      checks.historicalFullSnapshot = isDeepStrictEqual(beforeResult,
        delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(before)))));
      try {
        delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(before, { omitResults: true }))), COMPOUND_EXECUTION_REGISTRY);
        checks.historicalOmittedRefused = false;
      } catch (error) { checks.historicalOmittedRefused = String(error).includes('compound'); }
      for (const omitResults of [false, true]) {
        try {
          const snapshot = JSON.parse(JSON.stringify(saveDelegationSnapshot(after, { omitResults })));
          checks[omitResults ? 'omittedSnapshot' : 'fullSnapshot'] = isDeepStrictEqual(afterResult, delegationSnapshotResult(snapshot, COMPOUND_EXECUTION_REGISTRY));
        } catch (error) { checks[omitResults ? 'omittedSnapshot' : 'fullSnapshot'] = String(error); }
      }
      const xs = input.brief.cells.map(c => c.x), ys = input.brief.cells.map(c => c.y);
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
      records.push({ name: input.name, seed: input.seed, shape: { bounds, cells: input.brief.cells.length, density: input.brief.cells.length / (bounds.w * bounds.h) }, ...(input.source ? { source: input.source } : {}), brief: input.brief, checks, cords, yardDiagnostics, before: { generation: before, result: beforeResult, retention: matched ? matched.before.retention : retention(input.brief, before), geometrySource: matched ? 'historical comparison report; not rerun' : 'current inspection', ...prior }, ...(previousReview ? { previousReview } : {}), after: { generation: after, result: afterResult, retention: retention(input.brief, after), ...current } });

    }
    let timing;
    if (opts.timing) {
      const lock = await acquireMachineLock('bench', { pollMs: 100 });
      try {
      // Sequential rounds, warmup first; no rendering, validation or assertions inside measurements.
      const timingInputs = inputs.filter(i => !i.source);
      const run = fn => { const start = performance.now(); for (const i of timingInputs) fn(i.brief); return performance.now() - start; };
      run(old.buildCompoundGeneration); run(buildCompoundGeneration);
      timing = { unit: 'ms per synthetic input set', warmups: 1, rounds: [] };
      for (let i = 0; i < 3; i++) timing.rounds.push({ before: run(old.buildCompoundGeneration), after: run(buildCompoundGeneration) });
      // Match the existing macro-compound acceptance fixture; time it separately
      // rather than letting the tiny cases conceal scale-dependent costs.
      const owned = cells(200, 150), portals = [];
      for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
      for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
      const macroBrief = { id: 'field', seed: 3, type: 'compound', cellSize: 40, cells: owned, portals,
        zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells: owned }], parameters: { gates: 4 } };
      const timeMacro = fn => { const start = performance.now(); const node = fn(macroBrief); return { ms: performance.now() - start,
        children: node.children?.length ?? 0, ring: ring(flattenDelegationResult(node)) }; };
      timeMacro(old.buildCompoundGeneration); timeMacro(buildCompoundGeneration);
      timing.macro = { cells: owned.length, portals: portals.length, rounds: [] };
      for (let i = 0; i < 3; i++) {
        const before = timeMacro(old.buildCompoundGeneration), after = timeMacro(buildCompoundGeneration);
        if (!isDeepStrictEqual(before.ring, after.ring)) throw Error('Macro ring changed');
        timing.macro.rounds.push({ before: before.ms, after: after.ms, beforeChildren: before.children, afterChildren: after.children });
      }
      const macroDiagnostics = [];
      buildCompoundGeneration(macroBrief, { observeYard: report => macroDiagnostics.push(report) });
      timing.macro.diagnostics = macroDiagnostics;
      } finally { lock.release(); }
    }
    const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const failed = records.some(r => Object.values(r.checks).some(v => v !== true) || r.after.failures.length)
      || (production?.maps.some(map => !map.valid) ?? false);
    const baselineFindings = records.filter(r => r.before.failures.length).map(r => ({ name: r.name, seed: r.seed, failures: r.before.failures }));
    if (production) for (const map of production.maps) {
      const matching = records.filter(r => r.source?.map === map.seed);
      map.uptake = { beforeWithChildren: matching.filter(r => r.before.generation.children?.length).length,
        afterWithChildren: matching.filter(r => r.after.generation.children?.length).length,
        beforeChildren: matching.reduce((n, r) => n + (r.before.generation.children?.length ?? 0), 0),
        afterChildren: matching.reduce((n, r) => n + (r.after.generation.children?.length ?? 0), 0),
        displacedInitialRoutes: matching.filter(r => r.cords?.displaced?.length).length };
    }
    const synthetic = records.filter(r => !r.source);
    const syntheticUptake = { cases: synthetic.length, beforeWithChildren: synthetic.filter(r => r.before.generation.children?.length).length,
      afterWithChildren: synthetic.filter(r => r.after.generation.children?.length).length,
      beforeChildren: synthetic.reduce((n, r) => n + (r.before.generation.children?.length ?? 0), 0),
      afterChildren: synthetic.reduce((n, r) => n + (r.after.generation.children?.length ?? 0), 0) };
    const diagnosticCounts = { cases: records.length, withoutYardEvent: 0, outcomes: {}, fallbackReasons: {}, refusals: {}, considered: 0, filtered: 0, probed: 0, accepted: 0 };
    for (const record of records) {
      if (!record.yardDiagnostics.length) diagnosticCounts.withoutYardEvent++;
      for (const event of record.yardDiagnostics) {
        diagnosticCounts.outcomes[event.outcome] = (diagnosticCounts.outcomes[event.outcome] ?? 0) + 1;
        if (event.reason) diagnosticCounts.fallbackReasons[event.reason] = (diagnosticCounts.fallbackReasons[event.reason] ?? 0) + 1;
        for (const key of ['considered', 'filtered', 'probed', 'accepted']) diagnosticCounts[key] += event[key];
        for (const [reason, count] of Object.entries(event.refusals)) diagnosticCounts.refusals[reason] = (diagnosticCounts.refusals[reason] ?? 0) + count;
      }
    }
    const retentionDistributions = { synthetic: distributions(synthetic), production: distributions(records.filter(r => r.source)) };
    const allocation = { definition: 'Offered cells sum all root offers, including rejected offers; transferred cells are root input cells minus retained cells.',
      synthetic: Object.fromEntries(['before', 'previousReview', 'after'].map(side => [side, aggregate(synthetic, side)])),
      production: Object.fromEntries(['before', 'previousReview', 'after'].map(side => [side, aggregate(records.filter(r => r.source), side)])) };
    const report = { allocation, ...(comparisonSource ? { comparisonSource } : {}), diagnosticCounts, retentionDistributions, syntheticUptake, ...(production ? { maps: production.maps } : {}), baseline: { commit: BASELINE, note: comparisonSource ? 'Matching before geometry is reused from the comparison report; other baseline cases use pinned compound source with current supporting modules. See each geometrySource.' : 'Pinned compound source with current supporting modules, loaded as temporary sibling.', findings: baselineFindings }, currentCommit, trackedDirtyFiles: execFileSync('git', ['status', '--short', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim(), seeds: opts.seeds, failed, records, ...(timing ? { timing } : {}) };
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(dir, 'index.html'), renderReport(report));
    process.stdout.write(`Wrote ${dir}; ${records.length} cases, ${syntheticUptake.beforeWithChildren}/${syntheticUptake.afterWithChildren} synthetic cases with children before/after, ${records.filter(r => r.cords?.displaced?.length).length} displaced initial routes; ${failed ? 'CURRENT FAILURES: inspect results.json' : 'current checks passed'}; ${baselineFindings.length} baseline cases with findings.\n`);
    if (failed) process.exitCode = 1;
  } finally { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
