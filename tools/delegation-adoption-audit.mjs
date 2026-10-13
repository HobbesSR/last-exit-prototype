#!/usr/bin/env node
// Read-only candidate evidence for #331. No production builder policy is installed.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generate } from '../map/chain.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { buildCover } from '../map/micro/strategies/cover.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { outline } from '../shared/shape.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(seeds|out|maps)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --seeds=20 --out=test-results/331-audit --maps=1.');
  return [match[1], match[2]];
}));
const seeds = Number(args.get('seeds') ?? 20), out = resolve(args.get('out') ?? 'test-results/331-audit');
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100) throw new Error('seeds must be 1..100');
if (args.has('maps') && args.get('maps') !== '1') throw new Error('maps must be 1');
await mkdir(out, { recursive: true });
const round = n => +n.toFixed(3);
const rectCells = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) => ({ x: n % w, y: Math.floor(n / w) })).filter(c => keep(c.x, c.y));
const shapes = [
  { name: 'small', w: 17, h: 16 },
  { name: 'rectangle', w: 24, h: 18 },
  { name: 'field', w: 40, h: 34 },
  { name: 'concave', w: 40, h: 34, keep: (x, y) => y < 20 || x < 20 },
];
const boxOf = result => {
  if (!result.elements.length) return null;
  const size = result.brief.cellSize;
  const boxes = result.elements.map(e => ({ x: e.x / size, y: e.y / size, w: e.template.w / size, h: e.template.h / size }));
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
const inBox = (c, b, pad = 0) => c.x >= b.x - pad && c.x < b.x + b.w + pad && c.y >= b.y - pad && c.y < b.y + b.h + pad;

function inspect(brief, result) {
  const blockers = result.elements.flatMap(e => elementShapes(e));
  const fill = measureFill(brief, result.elements);
  const box = brief.type === 'compound' ? boxOf(result) : null;
  // Exclude the entire compound box (including its intentionally empty court),
  // a two-cell approach band, and the region perimeter. This is candidate
  // measurement, not a declaration that the remaining cells are expendable.
  const owned = new Set(brief.cells.map(c => `${c.x},${c.y}`));
  const exterior = box ? brief.cells.filter(c => !inBox(c, box, 2)
    && [-2, -1, 0, 1, 2].every(d => owned.has(`${c.x + d},${c.y}`) && owned.has(`${c.x},${c.y + d}`))) : [];
  const outsideFill = box ? measureFill({ ...brief, cells: exterior }, result.elements) : null;
  return { cells: brief.cells.length, elements: result.elements.length, rooms: result.manifest.rooms ?? 0,
    warehouses: result.manifest.warehouses ?? 0, rows: result.manifest.rows ?? 0,
    freeCells: fill.freeCells, largestGapCells: fill.largest ? fill.largest.w * fill.largest.h : 0,
    box, exteriorCandidateCells: exterior.length,
    exteriorLargest: outsideFill?.largest ?? null,
    portalErrors: validatePortalReach({ ...brief, blockers }).errors,
    fillErrors: validateFillConstraints(brief, blockers) };
}

function preview(brief, result, patch = []) {
  const xs = brief.cells.map(c => c.x), ys = brief.cells.map(c => c.y);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x + 1, h = Math.max(...ys) - y + 1;
  const cells = brief.cells.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="#e9edf1" stroke="#d8dde3" stroke-width=".03"/>`).join('');
  const offered = patch.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="#aad9b4"/>`).join('');
  const geometry = result.elements.flatMap(e => elementShapes(e)).map(s => `<polygon points="${outline(s).map(p => `${p.x / brief.cellSize},${p.y / brief.cellSize}`).join(' ')}" fill="#374151"/>`).join('');
  const portals = brief.portals.map(p => `<line x1="${p.x}" y1="${p.y}" x2="${p.x + (p.axis === 'h' ? p.length : 0)}" y2="${p.y + (p.axis === 'v' ? p.length : 0)}" stroke="#cf4b32" stroke-width=".25"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="780" viewBox="${x - 1} ${y - 3} ${w + 2} ${h + 5}"><rect x="${x - 1}" y="${y - 3}" width="${w + 2}" height="${h + 5}" fill="white"/><text x="${x}" y="${y - 1.4}" font-size=".8">${brief.id}: dark collision, red portals, green trial patch</text>${cells}${offered}${geometry}${portals}</svg>`;
}

function compoundAccessErrors(brief, parent, combined) {
  const blockers = combined.elements.flatMap(e => elementShapes(e));
  const access = createAccessMask(brief), radius = hunterClearance(brief.cellSize);
  const from = portalStands(brief)[0]?.points[0], box = boxOf(parent), size = brief.cellSize;
  if (!from || !box) return ['Missing compound or portal start for access witness'];
  const targets = parent.elements.filter(e => e.label.startsWith('compound-room')).map(e => ({
    label: e.label, point: { x: e.x + e.template.w / 2, y: e.y + e.template.h / 2 } }));
  targets.push({ label: 'court', point: { x: (box.x + box.w / 2) * size, y: (box.y + box.h / 2) * size } });
  for (const e of parent.elements.filter(e => e.label.startsWith('compound-gate'))) {
    const side = e.label.at(-1), point = { x: e.x + e.template.w / 2, y: e.y + e.template.h / 2 };
    if (side === 'N') point.y = box.y * size - size;
    if (side === 'S') point.y = (box.y + box.h) * size + size;
    if (side === 'W') point.x = box.x * size - size;
    if (side === 'E') point.x = (box.x + box.w) * size + size;
    targets.push({ label: `${e.label}-yard-stand`, point });
  }
  return targets.filter(t => !findRegionRoute(access, blockers, from, t.point, radius)).map(t => `No sampled hunter route to ${t.label}`);
}

const direct = [], witnesses = [];
for (const shape of shapes) for (const type of ['compound', 'depot']) {
  const cells = rectCells(shape.w, shape.h, shape.keep), runs = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const brief = { id: `${type}-${seed}`, seed, type, cellSize: 40, cells,
      zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals: [
        { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
        { id: 'east', axis: 'v', x: shape.w, y: 8, length: 2 }] };
    const start = performance.now(), result = buildRegion(brief), buildMs = round(performance.now() - start);
    const report = inspect(brief, result);
    runs.push({ seed, buildMs, ...report });
    if (seed === 1) await writeFile(resolve(out, `${type}-${shape.name}.svg`), preview(brief, result));
    // One explicit rectangle witness, not an automatic lobe policy. Parent geometry
    // stays fixed; SDK feasibility and final emitted geometry both have to pass.
    if (type === 'compound' && seed === 1 && report.exteriorLargest) {
      const b = report.exteriorLargest, patch = rectCells(b.w, b.h).map(c => ({ x: c.x + b.x, y: c.y + b.y }));
      const blockers = result.elements.flatMap(e => elementShapes(e));
      const started = performance.now();
      const prepared = prepareDelegation(brief, [{ key: 'exterior-witness', cells: patch, type: 'cover', reasonTags: ['unused-exterior-yard'] }], {
        blockers, receiving: child => buildCover(child).elements.length ? null : 'cover has no usable placement' });
      const children = prepared.children.map(child => buildCover(child.brief));
      const combined = { ...result, elements: [...result.elements, ...children.flatMap(child => child.elements)] };
      const combinedBlockers = combined.elements.flatMap(e => elementShapes(e));
      const portalErrors = validatePortalReach({ ...brief, blockers: combinedBlockers }).errors;
      const leafErrors = [validateFillConstraints(prepared.retained, blockers), ...children.map(child => validateFillConstraints(child.brief, child.elements.flatMap(e => elementShapes(e))))].flat();
      const crossingErrors = [prepared.retained, ...prepared.children.map(child => child.brief)]
        .flatMap(owner => validatePortalReach({ ...owner, blockers: combinedBlockers }).errors);
      const compoundAccess = compoundAccessErrors(brief, result, combined);
      witnesses.push({ shape: shape.name, seed, patch: b, patchCells: patch.length, accepted: prepared.children.length,
        rejected: prepared.rejected, childElements: children.reduce((n, child) => n + child.elements.length, 0),
        trialMs: round(performance.now() - started), portalErrors, leafErrors, crossingErrors, compoundAccessErrors: compoundAccess,
        before: report, after: { freeCells: measureFill(brief, combined.elements).freeCells } });
      await writeFile(resolve(out, `compound-${shape.name}-trial.svg`), preview(brief, combined, patch));
    }
  }
  const times = runs.map(r => r.buildMs).sort((a, b) => a - b);
  const sum = field => runs.reduce((n, r) => n + r[field], 0);
  direct.push({ shape: shape.name, type, seeds, buildMedianMs: times[Math.ceil(times.length / 2) - 1],
    freeShare: round(sum('freeCells') / sum('cells')), exteriorCandidateMean: round(sum('exteriorCandidateCells') / seeds),
    largestGapCells: Math.max(...runs.map(r => r.largestGapCells)),
    exteriorLargestGapCells: Math.max(...runs.map(r => r.exteriorLargest ? r.exteriorLargest.w * r.exteriorLargest.h : 0)), runs });
}

const fullMaps = [];
if (args.has('maps')) for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
  const seed = `issue330-before-${zoneWidth}x${zoneHeight}`, start = performance.now();
  const map = generate(seed, { mode: 'game', zoneWidth, zoneHeight });
  const generationMs = round(performance.now() - start);
  const candidates = map.results.filter(r => ['compound', 'depot'].includes(r.brief.type));
  const reports = [];
  for (const result of candidates) {
    const report = inspect(result.brief, result);
    reports.push({ id: result.brief.id, seed: result.brief.seed, type: result.brief.type, ...report });
  }
  fullMaps.push({ seed, zoneWidth, zoneHeight, generationMs, reports });
}
const output = { audit: 'delegation-adoption-candidates-1', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  contentVersion: REGION_TYPES_VERSION, seeds, direct, witnesses, fullMaps,
  limits: 'Current output only; single build timing per seed. Free cells include intentional space. Exterior mask is a candidate diagnostic, not production policy or reserved route extraction. Trial cover preserves parent elements and checks sampled room/court/gate access but does not implement retained loot, executor/snapshot or full fallback. Full-map checks cover listed top-level candidates, not all map regions or nested block lots.' };
await writeFile(resolve(out, 'report.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ out, direct: direct.map(({ runs, ...summary }) => summary), witnesses, fullMaps: fullMaps.map(({ reports, ...map }) => ({ ...map, candidates: reports.length, compound: reports.filter(r => r.type === 'compound').length, depot: reports.filter(r => r.type === 'depot').length, geometryErrors: reports.reduce((n, r) => n + r.portalErrors.length + r.fillErrors.length, 0) })) }, null, 2));
