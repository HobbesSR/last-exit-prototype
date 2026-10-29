#!/usr/bin/env node
/** Same-input hut cord evidence (#647). Run with Node's TypeScript support. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { chainBrief, chainFixtures } from '../tests/helpers/chain-briefs.js';
import { hutCordEvidence } from '../tests/helpers/hut-cord-geometry.js';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { generate } from '../map/chain.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { checkMap } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/tools/engines.ts';
import { planBlock } from '../map/micro/strategies/block.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = '71a00c3';
const cells = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) })).filter(c => keep(c.x, c.y));
const cases = [
  { name: 'small', cells: cells(6, 6), portals: [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }] },
  { name: 'rectangle', cells: cells(24, 18), portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 }] },
  { name: 'broad-concave', cells: cells(28, 12, (x, y) => y < 8 || x < 18), portals: [{ id: 'north', axis: 'h', x: 2, y: 0, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 3 }] },
  { name: 'ring', cells: cells(14, 14, (x, y) => x < 5 || x >= 9 || y < 5 || y >= 9), portals: [{ id: 'north', axis: 'h', x: 6, y: 0, length: 2 }, { id: 'hole', axis: 'v', x: 9, y: 6, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 10, length: 3 }] },
  { ...chainFixtures()[0], name: 'chain-internal-margins' },
];
function options(args) {
  const out = { seeds: 3, timing: false, maps: false, dir: 'test-results/hut-cords' };
  for (const arg of args) {
    if (arg === '--timing') out.timing = true;
    else if (arg === '--maps') out.maps = true;
    else if (arg.startsWith('--seeds=')) out.seeds = Number(arg.slice(8));
    else if (arg.startsWith('--out=')) out.dir = arg.slice(6);
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.seeds) || out.seeds < 1 || out.seeds > 50 || !out.dir) throw Error('Use --seeds=1..50, --out=DIRECTORY, --timing, --maps.');
  return out;
}
const brief = (c, seed) => chainBrief({ ...c, id: `cord-${c.name}`, type: 'hut', seed });
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
      ...briefs.filter(b => b.type === 'hut').map(b => ({ brief: b, location: 'top-level' })),
      ...briefs.filter(b => b.type === 'block').flatMap(block => planBlock(block).lots
        .filter(b => b.type === 'hut').map(b => ({ brief: b, location: 'block-lot', block: block.id }))),
    ];
    const unique = new Map();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.brief.id);
      if (previous && !isDeepStrictEqual(previous.brief, candidate.brief))
        throw Error(`Different hut briefs share id ${candidate.brief.id} in ${spec.seed}`);
      if (!previous) unique.set(candidate.brief.id, candidate);
    }
    const collected = [...unique.values()];
    maps.push({ ...spec, valid: check.valid, defects: check.defects, candidates: candidates.length,
      uniqueHuts: collected.length, topLevel: collected.filter(c => c.location === 'top-level').length,
      blockLots: collected.filter(c => c.location === 'block-lot').length });
    process.stdout.write(`${spec.seed}: ${collected.length} unique huts (${candidates.length} candidates); auditing all.\n`);
    for (const candidate of collected) inputs.push({ name: `${spec.seed} / ${candidate.brief.id}`,
      seed: candidate.brief.seed, brief: candidate.brief, source: { map: spec.seed, location: candidate.location, ...(candidate.block ? { block: candidate.block } : {}) } });
  }
  return { inputs, maps };
}
const house = result => result.elements.filter(e => e.label === 'hut-building');
function geometry(result) {
  const placed = result.elements.flatMap(e => elementShapes(e, true));
  const blockers = result.elements.flatMap(e => elementShapes(e));
  return { fill: validateFillConstraints(result.brief, placed), reach: validatePortalReach({ ...result.brief, blockers }, { search: 'thorough' }).errors };
}
function inspect(node) {
  const owners = [], failures = [];
  function visit(n) {
    const g = geometry(n.retained);
    owners.push({ id: n.retained.brief.id, cells: n.retained.brief.cells, geometry: g });
    if (g.fill.length || g.reach.length) failures.push({ scope: n.retained.brief.id, ...g });
    if (n.preparation) {
      const errors = validateBriefPartition(n.input, [n.retained.brief, ...(n.children ?? []).map(c => c.input)]);
      if (errors.length) failures.push({ scope: `${n.input.id} partition`, errors });
    }
    for (const child of n.children ?? []) visit(child);
  }
  visit(node);
  const whole = geometry(flattenDelegationResult(node));
  if (whole.fill.length || whole.reach.length) failures.push({ scope: 'whole', ...whole });
  return { owners, whole, failures };
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
  for (const e of result.elements) for (const s of elementShapes(e, true)) svg += shapeSvg(s, e.label.includes('hut-building') ? '#7a3830' : '#365b45');
  for (const p of b.portals) svg += `<line x1="${p.x * size}" y1="${p.y * size}" x2="${(p.x + (p.axis === 'h' ? p.length : 0)) * size}" y2="${(p.y + (p.axis === 'v' ? p.length : 0)) * size}" stroke="#d518ad" stroke-width="8"/>`;
  if (cords) {
    for (const [paths, color, dashed] of [[cords.initialPaths, '#d18b00', true], [cords.finalPaths ?? [], '#1264b7', false]])
      for (const path of paths) svg += `<polyline points="${path.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="5" ${dashed ? 'stroke-dasharray="12 8"' : ''}/>`;
    for (const p of cords.terminals) svg += `<circle cx="${p.x}" cy="${p.y}" r="8" fill="#1264b7"/>`;
  }
  return svg + '</svg>';
}
async function main() {
  const opts = options(process.argv.slice(2)), dir = resolve(ROOT, opts.dir);
  const source = execFileSync('git', ['show', `${BASELINE}:map/micro/strategies/hut.ts`], { cwd: ROOT, encoding: 'utf8' });
  const path = resolve(ROOT, 'map/micro/strategies', `.hut-cord-baseline-${randomUUID()}.ts`);
  try {
    await writeFile(path, source, { flag: 'wx' });
    const old = await import(`${pathToFileURL(path).href}?${randomUUID()}`);
    const inputs = cases.flatMap(c => Array.from({ length: opts.seeds }, (_, i) => ({ name: c.name, seed: i + 1, brief: brief(c, i + 1) })));
    const production = opts.maps ? productionInputs() : undefined;
    if (production) inputs.push(...production.inputs);
    const records = [], panels = [];
    for (const input of inputs) {
      const before = old.buildHutGeneration(input.brief), after = buildHutGeneration(input.brief);
      const beforeResult = flattenDelegationResult(before), afterResult = flattenDelegationResult(after);
      const prior = inspect(before), current = inspect(after), checks = {};
      const cords = hutCordEvidence(after, afterResult);
      checks.actualDoorAccess = cords?.finalAccess ?? true;
      checks.houseUnchanged = isDeepStrictEqual(house(beforeResult), house(afterResult));
      checks.deterministic = isDeepStrictEqual(after, buildHutGeneration(input.brief));
      checks.historicalFullSnapshot = isDeepStrictEqual(beforeResult,
        delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(before)))));
      try {
        delegationSnapshotResult(JSON.parse(JSON.stringify(saveDelegationSnapshot(before, { omitResults: true }))), HUT_EXECUTION_REGISTRY);
        checks.historicalOmittedRefused = false;
      } catch (error) { checks.historicalOmittedRefused = String(error).includes('hut'); }
      for (const omitResults of [false, true]) {
        try {
          const snapshot = JSON.parse(JSON.stringify(saveDelegationSnapshot(after, { omitResults })));
          checks[omitResults ? 'omittedSnapshot' : 'fullSnapshot'] = isDeepStrictEqual(afterResult, delegationSnapshotResult(snapshot, HUT_EXECUTION_REGISTRY));
        } catch (error) { checks[omitResults ? 'omittedSnapshot' : 'fullSnapshot'] = String(error); }
      }
      const xs = input.brief.cells.map(c => c.x), ys = input.brief.cells.map(c => c.y);
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
      records.push({ name: input.name, seed: input.seed, shape: { bounds, cells: input.brief.cells.length, density: input.brief.cells.length / (bounds.w * bounds.h) }, ...(input.source ? { source: input.source } : {}), brief: input.brief, checks, cords, before: { generation: before, result: beforeResult, ...prior }, after: { generation: after, result: afterResult, ...current } });
      panels.push(`<section><h2>${esc(input.name)} — seed ${input.seed}</h2><div class="pair"><figure><figcaption>Before (${BASELINE})</figcaption>${panel(input.brief, beforeResult, prior.owners)}</figure><figure><figcaption>After</figcaption>${panel(input.brief, afterResult, current.owners, cords)}</figure></div><p>After overlays: dashed amber is the initial house-envelope route; blue is independently rediscovered final access, dots are door approaches. Displaced initial routes: ${esc(cords?.displaced.join(', ') || 'none')}. Checks: ${esc(JSON.stringify(checks))}; geometry failures before ${prior.failures.length}, after ${current.failures.length}. See JSON for details.</p></section>`);
    }
    let timing;
    if (opts.timing) {
      const lock = await acquireMachineLock('bench');
      try {
      // Sequential rounds, warmup first; no rendering, validation or assertions inside measurements.
      const timingInputs = inputs.filter(i => !i.source);
      const run = fn => { const start = performance.now(); for (const i of timingInputs) fn(i.brief); return performance.now() - start; };
      run(old.buildHutGeneration); run(buildHutGeneration);
      timing = { unit: 'ms per synthetic input set', warmups: 1, rounds: [] };
      for (let i = 0; i < 3; i++) timing.rounds.push({ before: run(old.buildHutGeneration), after: run(buildHutGeneration) });
      // Match the existing macro-hut acceptance fixture; time it separately
      // rather than letting the tiny cases conceal scale-dependent costs.
      const owned = cells(172, 172), portals = [];
      for (let i = 0; i + 2 <= 172; i += 3) portals.push(
        { id: `n${i}`, axis: 'h', x: i, y: 0, length: 2 }, { id: `s${i}`, axis: 'h', x: i, y: 172, length: 2 },
        { id: `w${i}`, axis: 'v', x: 0, y: i, length: 2 }, { id: `e${i}`, axis: 'v', x: 172, y: i, length: 2 });
      const macroBrief = { id: 'field', seed: 3, type: 'hut', cellSize: 40, cells: owned, portals,
        zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells: owned }] };
      const timeMacro = fn => { const start = performance.now(); const node = fn(macroBrief); return { ms: performance.now() - start,
        children: node.children?.length ?? 0, house: house(flattenDelegationResult(node))[0] }; };
      timeMacro(old.buildHutGeneration); timeMacro(buildHutGeneration);
      timing.macro = { cells: owned.length, portals: portals.length, rounds: [] };
      for (let i = 0; i < 3; i++) {
        const before = timeMacro(old.buildHutGeneration), after = timeMacro(buildHutGeneration);
        if (!isDeepStrictEqual(before.house, after.house)) throw Error('Macro house changed');
        timing.macro.rounds.push({ before: before.ms, after: after.ms, beforeChildren: before.children, afterChildren: after.children });
      }
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
        displacedInitialRoutes: matching.filter(r => r.cords?.displaced.length).length };
    }
    const synthetic = records.filter(r => !r.source);
    const syntheticUptake = { cases: synthetic.length, beforeWithChildren: synthetic.filter(r => r.before.generation.children?.length).length,
      afterWithChildren: synthetic.filter(r => r.after.generation.children?.length).length,
      beforeChildren: synthetic.reduce((n, r) => n + (r.before.generation.children?.length ?? 0), 0),
      afterChildren: synthetic.reduce((n, r) => n + (r.after.generation.children?.length ?? 0), 0) };
    const report = { syntheticUptake, ...(production ? { maps: production.maps } : {}), baseline: { commit: BASELINE, note: 'Pinned hut source with current supporting modules, loaded as temporary sibling.', findings: baselineFindings }, currentCommit, hutStatus: execFileSync('git', ['status', '--short', '--', 'map/micro/strategies/hut.ts'], { cwd: ROOT, encoding: 'utf8' }).trim(), seeds: opts.seeds, failed, records, ...(timing ? { timing } : {}) };
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Hut cord audit</title><style>body{font:16px system-ui;margin:2em}section{border-top:1px solid #aaa}.pair{display:flex;gap:1em}figure{margin:0;flex:1}svg{width:100%;max-height:500px;background:#fff}figcaption{font-weight:bold}</style><h1>Hut cord audit</h1><p>Same brief and seed. Cell colours indicate owners; brown geometry is the house, green is cover, magenta marks external portals. Baseline uses current supporting modules. Full raw results and diagnostic errors: <a href="results.json">results.json</a>.</p>${production ? `<h2>Production maps</h2><p>All unique top-level huts and block lots are shown below. Counts, map defects and uptake: <code>${esc(JSON.stringify(production.maps))}</code></p>` : ''}${panels.join('')}`);
    process.stdout.write(`Wrote ${dir}; ${failed ? 'CURRENT FAILURES: inspect results.json' : 'current checks passed'}; ${baselineFindings.length} baseline cases with findings (retained in report)\n`);
    if (failed) process.exitCode = 1;
  } finally { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
