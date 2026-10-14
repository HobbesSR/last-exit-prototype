#!/usr/bin/env node
/** Exact, read-only #340 witness. Default regenerates the source map; --brief
 * permits the checked-in focused input without relying on previous audit output. */
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { generate } from '../map/chain.ts';
import { clearFootprint } from '../map/kernel/margins.ts';
import { createFillMask, createRegionMask, elementShapes } from '../map/micro/geometry.ts';
import { largestRectangle } from '../map/micro/strategies/hall.ts';
import { diagnoseCompoundSiting, buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validatePortalReach, portalStands } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { outline } from '../shared/shape.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(out|brief)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --out=test-results/340-audit [--brief=tests/fixtures/compound-340-brief.json.gz]');
  return [match[1], match[2]];
}));
const seed = 'issue330-before-36x18', params = { mode: 'game', zoneWidth: 36, zoneHeight: 18 };
const id = 'compound@336,342', out = resolve(args.get('out') ?? 'test-results/340-audit');
const map = args.has('brief') ? null : generate(seed, params);
const brief = args.has('brief') ? JSON.parse(gunzipSync(await readFile(resolve(args.get('brief')))))
  : map.results.find(r => r.brief.id === id)?.brief;
assert.equal(brief?.id, id);
const original = structuredClone(brief), diagnosis = diagnoseCompoundSiting(brief);
const node = buildCompoundGeneration(brief), flattened = flattenDelegationResult(node);
const result = { ...flattened, manifest: { ...flattened.manifest,
  ...(node.retained.manifest.rooms === undefined ? {} : { rooms: node.retained.manifest.rooms }),
  ...(node.retained.manifest.compoundGates === undefined ? {} : { compoundGates: node.retained.manifest.compoundGates }) } };
assert.deepEqual(brief, original);
if (map) assert.deepEqual(result, map.results.find(r => r.brief.id === id));
const key = c => `${c.x},${c.y}`, fill = createFillMask(brief);
// Independent maximal-square proof, not the builder's rectangle heuristic.
const dp = new Map();
let maximumSquare = { side: 0 };
for (const c of fill.cells) {
  const side = 1 + Math.min(dp.get(`${c.x - 1},${c.y}`) ?? 0,
    dp.get(`${c.x},${c.y - 1}`) ?? 0, dp.get(`${c.x - 1},${c.y - 1}`) ?? 0);
  dp.set(key(c), side);
  if (side > maximumSquare.side) maximumSquare = { x: c.x - side + 1, y: c.y - side + 1, side };
}
// Isolate the internal obligations: their margins alone already prevent a ring.
// This is a constraint proof, never a build with weakened guarantees.
const internalClear = clearFootprint(brief.internalGuaranteed ?? [], brief.cells);
const internalKeys = new Set(internalClear.map(key));
const internalOnlyFill = createRegionMask({ ...brief, cells: brief.cells.filter(c => !internalKeys.has(key(c))) });
const blockers = result.elements.flatMap(e => elementShapes(e));
const access = validatePortalReach({ ...brief, blockers });
const report = {
  audit: 'compound-siting-340-1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyPaths: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean),
  contentVersion: REGION_TYPES_VERSION, inputSource: args.get('brief') ?? 'regenerated-map', seed, params, id,
  briefSha256: createHash('sha256').update(JSON.stringify(brief)).digest('hex'),
  cells: brief.cells.length, fillCells: fill.cells.length, clearContextCells: brief.clearCells.length,
  ownedClearCells: brief.cells.length - fill.cells.length, portals: brief.portals.length,
  internalGuaranteed: brief.internalGuaranteed.length, internalClearOwnedCells: internalClear.length,
  maximumSquare, largestFillRectangle: largestRectangle(fill, 1),
  largestTwoAxisRectangle: largestRectangle(fill, 2),
  internalOnlyMinimumTenRectangle: largestRectangle(internalOnlyFill, 10) ?? null,
  diagnosis, execution: { actualBuilder: node.actualBuilder, fallbackKind: node.fallbackKind,
    fallbackReason: node.fallbackReason, manifest: result.manifest },
  access: { valid: access.valid, errors: access.errors, routes: access.routes.length,
    portalStandCount: portalStands(brief).reduce((n, p) => n + p.points.length, 0),
    compoundTargets: diagnosis.site ? 'Ring emitted; use compound-siting-solution-audit.mjs for room/court/gate target checks'
      : 'absent: no ring, court, rooms or gates were emitted' },
  fillErrors: validateFillConstraints(brief, blockers),
  decision: diagnosis.site ? 'A contained ring was accepted under this input; the authored #340 correction is compared separately by compound-siting-solution-audit.mjs.'
    : 'Expected constraint fallback. No siting optimization can fit a 10x10 box; producing a ring needs a separately reviewed authored-content or builder-design change.',
  limits: 'One exact input; collision preview, not roofs or live movement. Internal-only fill is a diagnostic proof, never production policy. Portal validation is sampled; each found route is swept-body checked. This read-only tool does not select content policy or capture baselines; use the solution audit to compare the authored correction.'
};
if (args.has('brief') && report.briefSha256 === 'ea08497ff53070560aed9c5d50f25d270d95cbee30f879fddbd5ea3e66d513b2') {
  assert.equal(maximumSquare.side, 4);
  assert.equal(diagnosis.space, null);
  assert.equal(diagnosis.probes.length, 0);
  assert.equal(report.internalOnlyMinimumTenRectangle, null);
}
assert.deepEqual(access.errors, []);
assert.deepEqual(report.fillErrors, []);

function svg() {
  const bounds = createRegionMask(brief).bounds, size = brief.cellSize;
  const x = bounds.x / size, y = bounds.y / size, w = bounds.w / size, h = bounds.h / size;
  const cells = (cs, color) => cs.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="${color}"/>`).join('');
  const runs = (rs, color, thickness) => rs.map(r => `<line x1="${r.x}" y1="${r.y}" x2="${r.x + (r.axis === 'h' ? r.length : 0)}" y2="${r.y + (r.axis === 'v' ? r.length : 0)}" stroke="${color}" stroke-width="${thickness}"/>`).join('');
  const geometry = blockers.map(s => `<polygon points="${outline(s).map(p => `${p.x / size},${p.y / size}`).join(' ')}" fill="#1f2937"/>`).join('');
  const panel = (shift, label, body) => `<g transform="translate(${shift} 0)"><text x="${x}" y="${y - 3}" font-size="2">${label}</text>${body}${runs(brief.portals, '#dc2626', .5)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="650" viewBox="${x - 2} ${y - 10} ${2 * w + 12} ${h + 28}"><rect x="${x - 2}" y="${y - 10}" width="${2 * w + 12}" height="${h + 28}" fill="white"/>
    <text x="${x}" y="${y - 7}" font-size="3">#340 ${id}: red original portals; blue internal guarantees</text>
    ${panel(0, 'Allowed fill (green), clear margins (pale blue)', cells(brief.cells, '#dbeafe') + cells(fill.cells, '#86efac') + runs(brief.internalGuaranteed, '#2563eb', .16))}
    ${panel(w + 6, `Emitted ${diagnosis.site ? 'ring' : 'empty'} output: ${brief.portals.length} original portals connected`, cells(brief.cells, '#f1f5f9') + geometry + access.routes.map(r => `<polyline points="${r.points.map(p => `${p.x / size},${p.y / size}`).join(' ')}" fill="none" stroke="#a78bfa" stroke-width=".08"/>`).join(''))}
    <text x="${x}" y="${y + h + 6}" font-size="2">Largest fill square: ${maximumSquare.side}x${maximumSquare.side}; required ring box: 10x10. Candidate probes: ${diagnosis.probes.length}.</text>
    <text x="${x}" y="${y + h + 10}" font-size="2">Preview shows emitted collision geometry and sampled swept hunter routes. See JSON for exact siting reason.</text></svg>`;
}
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'brief.json'), JSON.stringify(brief) + '\n');
await writeFile(resolve(out, 'result.json'), JSON.stringify(result) + '\n');
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(out, 'preview.svg'), svg());
console.log(JSON.stringify({ out, ...report }, null, 2));
