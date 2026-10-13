#!/usr/bin/env node
/** Bounded before/after evidence for compound exterior-yard delegation (#338). */
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { generate } from '../map/chain.ts';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { flattenDelegationResult, executionLeaves } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { outline } from '../shared/shape.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(seeds|maps|out)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --seeds=20 --maps=1 --out=test-results/338-after.');
  return [match[1], match[2]];
}));
const seeds = Number(args.get('seeds') ?? 20);
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100) throw new Error('seeds must be 1..100');
if (args.has('maps') && args.get('maps') !== '1') throw new Error('maps must be 1');
const out = resolve(args.get('out') ?? 'test-results/338-after');
const baselinePath = resolve('test-results/331-audit/report.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.audit !== 'delegation-adoption-candidates-1' || baseline.contentVersion !== 'types-24' || baseline.seeds < seeds)
  throw new Error('The preserved #331 baseline must have the requested seeds.');
if (args.has('maps') && baseline.fullMaps.length !== 3) throw new Error('The preserved #331 baseline needs all three maps.');
await mkdir(out, { recursive: true });
const round = n => Number(n.toFixed(3));
const key = c => `${c.x},${c.y}`;
const rectCells = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) => ({ x: n % w, y: Math.floor(n / w) })).filter(c => keep(c.x, c.y));
const shapes = [
  { name: 'small', w: 17, h: 16 },
  { name: 'rectangle', w: 24, h: 18 },
  { name: 'field', w: 40, h: 34 },
  { name: 'concave', w: 40, h: 34, keep: (x, y) => y < 20 || x < 20 },
];
const bounds = (cells) => {
  if (!cells.length) return null;
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
};
// Only the owner's retained ring defines the compound box. Child cover is never
// allowed to expand the ring whose surrounding space is being diagnosed.
function ringBox(parent) {
  const elements = parent.elements.filter(e => e.label.startsWith('compound-'));
  if (!elements.length) return null;
  const size = parent.brief.cellSize;
  const boxes = elements.map(e => ({ x: e.x / size, y: e.y / size, w: e.template.w / size, h: e.template.h / size }));
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}
function candidate(brief, parent) {
  const box = ringBox(parent);
  if (!box) return { box: null, cells: [], largest: null };
  const owned = new Set(brief.cells.map(key));
  const within = c => c.x >= box.x - 2 && c.x < box.x + box.w + 2 && c.y >= box.y - 2 && c.y < box.y + box.h + 2;
  const cells = brief.cells.filter(c => !within(c) && [-2, -1, 0, 1, 2].every(d =>
    owned.has(`${c.x + d},${c.y}`) && owned.has(`${c.x},${c.y + d}`)));
  return { box, cells, largest: measureFill({ ...brief, cells }, parent.elements).largest };
}
function routeEvidence(brief, parent, combined) {
  const box = ringBox(parent), starts = portalStands(brief).flatMap(p => p.points);
  const blockers = combined.elements.flatMap(e => elementShapes(e)), access = createAccessMask(brief);
  const radius = hunterClearance(brief.cellSize), size = brief.cellSize;
  if (!box) return { starts: starts.length, targets: [], errors: [] };
  const targets = parent.elements.filter(e => e.label.startsWith('compound-room')).map(e => ({
    label: e.label, point: { x: e.x + e.template.w / 2, y: e.y + e.template.h / 2 }, kind: 'room' }));
  targets.push({ label: 'court', point: { x: (box.x + box.w / 2) * size, y: (box.y + box.h / 2) * size }, kind: 'court' });
  for (const e of parent.elements.filter(e => e.label.startsWith('compound-gate'))) {
    const side = e.label.at(-1), point = { x: e.x + e.template.w / 2, y: e.y + e.template.h / 2 };
    if (side === 'N') point.y = (box.y - 1) * size;
    if (side === 'S') point.y = (box.y + box.h + 1) * size;
    if (side === 'W') point.x = (box.x - 1) * size;
    if (side === 'E') point.x = (box.x + box.w + 1) * size;
    targets.push({ label: `${e.label}-yard-stand`, point, kind: 'gate-yard' });
  }
  const checked = targets.map(t => ({ ...t, reachable: starts.some(start => !!findRegionRoute(access, blockers, start, t.point, radius)) }));
  return { starts: starts.length, targets: checked, errors: starts.length ? checked.filter(t => !t.reachable).map(t => `No sampled hunter route to ${t.label}`) : [] };
}
function checks(brief, node, combined) {
  const blockers = combined.elements.flatMap(e => elementShapes(e));
  const leafErrors = executionLeaves(node).flatMap(leaf => validateFillConstraints(leaf.brief, leaf.elements.flatMap(e => elementShapes(e, true))));
  const crossingErrors = executionLeaves(node).flatMap(leaf => validatePortalReach({ ...leaf.brief, blockers }).errors);
  return { portalErrors: validatePortalReach({ ...brief, blockers }).errors,
    fillErrors: validateFillConstraints(brief, combined.elements.flatMap(e => elementShapes(e, true))), leafErrors, crossingErrors,
    routes: routeEvidence(brief, node.retained, combined) };
}
const offerReport = node => {
  const accepted = new Set(node.preparation?.children.map(c => c.key) ?? []);
  const reasons = new Map((node.preparation?.rejected ?? []).map(r => [r.key, r.reason]));
  return (node.offers ?? []).map(o => ({ key: o.key, type: o.type, reasonTags: o.reasonTags ?? [],
    cells: o.cells, cellCount: o.cells.length, bounds: bounds(o.cells), accepted: accepted.has(o.key),
    rejectionReason: reasons.get(o.key) ?? null }));
};
function trace(node) {
  return { inputId: node.input.id, depth: node.depth, requestedBuilder: node.requestedBuilder,
    actualBuilder: node.actualBuilder, builderVersion: node.builderVersion, fallbackKind: node.fallbackKind ?? null,
    fallbackReason: node.fallbackReason ?? null, registryVersions: node.registryVersions ?? null,
    maxDepth: node.maxDepth ?? null, offers: offerReport(node), children: (node.children ?? []).map(trace) };
}
function svg(brief, before, after, offers, diagnostic) {
  const area = bounds(brief.cells), size = brief.cellSize;
  const regions = brief.cells.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="#edf1f5" stroke="#d4dce4" stroke-width=".025"/>`).join('');
  const candidates = diagnostic.cells.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="#dbeafe"/>`).join('');
  const patches = offers.flatMap(o => o.cells.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="${o.accepted ? '#75c88b' : '#f3b1a9'}" fill-opacity=".75"/>`)).join('');
  const geometry = (elements, color) => elements.flatMap(e => elementShapes(e)).map(s => `<polygon points="${outline(s).map(p => `${p.x / size},${p.y / size}`).join(' ')}" fill="${color}"/>`).join('');
  const portals = brief.portals.map(p => `<line x1="${p.x}" y1="${p.y}" x2="${p.x + (p.axis === 'h' ? p.length : 0)}" y2="${p.y + (p.axis === 'v' ? p.length : 0)}" stroke="#d04436" stroke-width=".22"/>`).join('');
  const panel = (shift, elements, label) => `<g transform="translate(${shift} 0)"><text x="${area.x}" y="${area.y - 1.4}" font-size=".8">${label}</text>${regions}${candidates}${patches}${geometry(elements, '#334155')}${portals}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="750" viewBox="${area.x - 1} ${area.y - 3} ${area.w * 2 + 6} ${area.h + 5}"><rect x="${area.x - 1}" y="${area.y - 3}" width="${area.w * 2 + 6}" height="${area.h + 5}" fill="white"/>${panel(0, before.elements, 'Before: ring and diagnostic candidate')}${panel(area.w + 3, after.elements, 'After: green accepted, coral rejected, blue diagnostic')}</svg>`;
}
async function audit(brief, baselineRun, previewName) {
  const started = performance.now(), node = buildCompoundGeneration(brief);
  const afterMs = round(performance.now() - started), after = flattenDelegationResult(node);
  const before = node.retained;
  const prior = candidate(brief, before);
  const offers = offerReport(node), validations = checks(brief, node, after);
  const full = saveDelegationSnapshot(node), omitted = saveDelegationSnapshot(node, { omitResults: true });
  const snapshot = { fullRecovered: isDeepStrictEqual(readDelegationSnapshot(full), node),
    omittedRecovered: isDeepStrictEqual(flattenDelegationResult(readDelegationSnapshot(omitted, COMPOUND_EXECUTION_REGISTRY)), after),
    version: full.version, algorithmVersion: full.algorithmVersion };
  const beforeFill = measureFill(brief, before.elements), afterFill = measureFill(brief, after.elements);
  const protectedCells = node.policyData?.protectedCells ?? [];
  const protectedKeys = new Set(protectedCells.map(key));
  const diagnosticAfterReservation = prior.cells.filter(c => !protectedKeys.has(key(c)));
  const summary = { id: brief.id, seed: brief.seed, cells: brief.cells.length,
    before: { elements: baselineRun?.elements ?? before.elements.length, retainedLoot: before.loot.length,
      freeCells: baselineRun?.freeCells ?? beforeFill.freeCells, retainedFreeCells: beforeFill.freeCells,
      buildMs: baselineRun?.buildMs ?? null, baselineBox: baselineRun?.box ?? null,
      ringBoxChanged: baselineRun ? !isDeepStrictEqual(baselineRun.box, prior.box) : null,
      diagnosticBox: prior.box, diagnosticCandidateCells: prior.cells.length,
      diagnosticFootprint: prior.cells,
      diagnosticLargest: prior.largest, baselineCandidateCells: baselineRun?.exteriorCandidateCells ?? null },
    reservations: { protectedCellCount: protectedCells.length, protectedCells,
      diagnosticRemainingCount: diagnosticAfterReservation.length, diagnosticRemainingFootprint: diagnosticAfterReservation },
    after: { elements: after.elements.length, loot: after.loot.length, freeCells: afterFill.freeCells, buildMs: afterMs },
    offers, offeredCells: offers.reduce((n, o) => n + o.cellCount, 0), accepted: offers.filter(o => o.accepted).length,
    rejected: offers.filter(o => !o.accepted).length, acceptedCells: offers.filter(o => o.accepted).reduce((n, o) => n + o.cellCount, 0),
    generation: trace(node), snapshot, validations };
  if (previewName) {
    await writeFile(resolve(out, previewName), svg(brief, before, after, offers, prior));
    const name = previewName.replace(/\.svg$/, '');
    await writeFile(resolve(out, `${name}.snapshot.json`), JSON.stringify(full, null, 2) + '\n');
    await writeFile(resolve(out, `${name}.omitted.json`), JSON.stringify(omitted, null, 2) + '\n');
  }
  return summary;
}

const direct = [];
for (const shape of shapes) {
  const baselineShape = baseline.direct.find(r => r.shape === shape.name && r.type === 'compound');
  if (!baselineShape) throw new Error(`Missing #331 baseline for ${shape.name}.`);
  const cells = rectCells(shape.w, shape.h, shape.keep), runs = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const brief = { id: `compound-${seed}`, seed, type: 'compound', cellSize: 40, cells,
      zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals: [
        { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
        { id: 'east', axis: 'v', x: shape.w, y: 8, length: 2 }] };
    runs.push(await audit(brief, baselineShape.runs.find(r => r.seed === seed), seed === 1 ? `compound-${shape.name}.svg` : null));
  }
  direct.push({ shape: shape.name, runs });
}

const fullMaps = [];
if (args.has('maps')) for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
  const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
  const prior = baseline.fullMaps.find(m => m.seed === seed);
  if (!prior) throw new Error(`Missing #331 map baseline for ${seed}.`);
  const started = performance.now(), map = generate(seed, { mode: 'game', zoneWidth, zoneHeight });
  const generationMs = round(performance.now() - started), reports = [];
  const briefs = map.results.filter(r => r.brief.type === 'compound').map(r => r.brief);
  const nested = map.results.filter(r => r.brief.type === 'block').flatMap(r => planBlock(r.brief).lots.filter(lot => lot.type === 'compound'));
  for (const brief of [...briefs, ...nested]) {
    const baselineRun = prior.reports.find(r => r.id === brief.id && r.type === 'compound');
    reports.push({ nested: nested.includes(brief), ...await audit(brief, baselineRun,
      `map-${zoneWidth}x${zoneHeight}-${reports.length}.svg`) });
  }
  fullMaps.push({ seed, zoneWidth, zoneHeight, generationMs, baselineGenerationMs: prior.generationMs,
    topLevelCompounds: briefs.length, nestedCompounds: nested.length, reports });
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirtyPaths = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const reports = [...direct.flatMap(d => d.runs), ...fullMaps.flatMap(m => m.reports)];
const errors = reports.flatMap(r => [
  ...r.validations.portalErrors, ...r.validations.fillErrors, ...r.validations.leafErrors,
  ...r.validations.crossingErrors, ...r.validations.routes.errors,
  ...(!r.snapshot.fullRecovered || !r.snapshot.omittedRecovered ? [`${r.id}: snapshot recovery failed`] : []),
]);
const output = { audit: 'compound-delegation-after-1', source: { commit, dirtyPaths, contentVersion: REGION_TYPES_VERSION,
    baseline: { path: baselinePath, commit: baseline.commit, contentVersion: baseline.contentVersion } },
  seeds, direct, fullMaps, errors,
  limits: 'Sequential single-run timing, not a regression claim. Baseline timing comes from preserved #331 report; current before geometry is rebuilt locally. Diagnostic exterior mask excludes the retained ring box and two-cell band, but is not production offer policy. Route checks sample portal stands against room centers, court center and actual gate passage yard stands. Nested block lots are planned and audited separately; full map generation timing includes all map work.' };
await writeFile(resolve(out, 'report.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ out, direct: direct.map(d => ({ shape: d.shape, offers: d.runs.reduce((n, r) => n + r.offers.length, 0),
  accepted: d.runs.reduce((n, r) => n + r.accepted, 0), rejected: d.runs.reduce((n, r) => n + r.rejected, 0) })),
  fullMaps: fullMaps.map(m => ({ seed: m.seed, generationMs: m.generationMs, topLevelCompounds: m.topLevelCompounds,
    nestedCompounds: m.nestedCompounds, offers: m.reports.reduce((n, r) => n + r.offers.length, 0) })), errors: errors.length }, null, 2));
if (errors.length) process.exitCode = 1;
