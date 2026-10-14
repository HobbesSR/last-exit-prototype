#!/usr/bin/env node
/** Same-seed #340 content correction: original input versus authored inward joins. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { generate, bundledLibrary } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { diagnoseCompoundSiting, buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { createAccessMask, createRegionMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { outline } from '../shared/shape.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(out|after-brief)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --out=test-results/340-solution [--after-brief=tests/fixtures/compound-340-inward-brief.json.gz]');
  return [match[1], match[2]];
}));
const seed = 'issue330-before-36x18', params = { mode: 'game', zoneWidth: 36, zoneHeight: 18 };
const id = 'compound@336,342', out = resolve(args.get('out') ?? 'test-results/340-solution');
const load = async path => JSON.parse(gunzipSync(await readFile(resolve(path))));
const beforeBrief = await load('tests/fixtures/compound-340-brief.json.gz');
const expectedAfter = await load('tests/fixtures/compound-340-inward-brief.json.gz');
const map = args.has('after-brief') ? null : generate(seed, params);
const afterBrief = args.has('after-brief') ? await load(args.get('after-brief'))
  : map.results.find(r => r.brief.id === id)?.brief;
assert.deepEqual(afterBrief, expectedAfter, 'fresh authored map matches the focused corrected input');
const preserved = ['id', 'seed', 'type', 'cellSize', 'cells', 'portals', 'zones', 'hints', 'coreElements', 'parameters'];
for (const field of preserved) assert.deepEqual(afterBrief[field], beforeBrief[field], `preserve original ${field}`);
const original = structuredClone(afterBrief), traces = [];
const beforeNode = buildCompoundGeneration(beforeBrief);
const afterNode = buildCompoundGeneration(afterBrief, { observe: trace => traces.push(trace) });
const before = flattenDelegationResult(beforeNode), flattened = flattenDelegationResult(afterNode);
// Match the public compound facade's retained-ring summary counters.
const after = { ...flattened, manifest: { ...flattened.manifest,
  rooms: afterNode.retained.manifest.rooms, compoundGates: afterNode.retained.manifest.compoundGates } };
assert.deepEqual(afterBrief, original);
if (map) assert.deepEqual(after, map.results.find(r => r.brief.id === id));
const diagnosis = diagnoseCompoundSiting(afterBrief), trace = traces.find(t => t.label === 'compound');
assert.ok(trace && diagnosis.site);
const site = diagnosis.site, size = afterBrief.cellSize;
const blockers = after.elements.flatMap(e => elementShapes(e));
const mask = createAccessMask(afterBrief), radius = hunterClearance(size), stands = portalStands(afterBrief);
const portal = validatePortalReach({ ...afterBrief, blockers });
const targets = afterNode.retained.elements.filter(e => e.label.startsWith('compound-room')).map(e => ({
  label: e.label, point: { x: e.x + e.template.w / 2, y: e.y + e.template.h / 2 } }));
targets.push({ label: 'court', point: { x: (site.x + site.w / 2) * size, y: (site.y + site.h / 2) * size } });
for (const opening of trace.realization.openings.filter(o => /^gate-[NESW]$/.test(o.connectionId))) {
  const side = opening.connectionId.at(-1), r = opening.run;
  const point = { x: trace.origin.x + (r.x + (r.axis === 'h' ? opening.center : 0)) * size,
    y: trace.origin.y + (r.y + (r.axis === 'v' ? opening.center : 0)) * size };
  point.x += side === 'W' ? -size : side === 'E' ? size : 0;
  point.y += side === 'N' ? -size : side === 'S' ? size : 0;
  targets.push({ label: `${opening.connectionId}-yard`, point });
}
const targetRoutes = targets.map(t => ({ ...t, route: findRegionRoute(mask, blockers, stands[0].points[0], t.point, radius) }));
const fillErrors = validateFillConstraints(afterBrief, after.elements.flatMap(e => elementShapes(e, true)));
const report = {
  audit: 'compound-siting-solution-340-1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyPaths: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean),
  seed, params, id, inputSource: args.get('after-brief') ?? 'regenerated-map', contentVersion: REGION_TYPES_VERSION,
  libraryFingerprint: libraryFingerprint(bundledLibrary(params)), preservedFields: preserved,
  before: { briefSha256: createHash('sha256').update(JSON.stringify(beforeBrief)).digest('hex'),
    internalGuaranteed: beforeBrief.internalGuaranteed.length, fillCells: beforeBrief.fillCells.length,
    manifest: before.manifest, diagnosis: diagnoseCompoundSiting(beforeBrief) },
  after: { briefSha256: createHash('sha256').update(JSON.stringify(afterBrief)).digest('hex'),
    internalGuaranteed: afterBrief.internalGuaranteed.length, fillCells: afterBrief.fillCells.length,
    manifest: after.manifest, diagnosis },
  access: { portalErrors: portal.errors, portalStandCount: stands.reduce((n, s) => n + s.points.length, 0),
    connectingRoutes: portal.routes.length, targetErrors: targetRoutes.filter(t => !t.route).map(t => t.label),
    targets: targetRoutes.map(({ label, point, route }) => ({ label, point, reachable: !!route })) },
  fillErrors, fullMapDefects: map ? mapViews(map, GAME_ENGINES.compose).report.defects : null,
  decision: 'Correct 312 military-quarter slot references to existing compound inward variants. Exposed prescriptions and original external portal relationships are preserved; internal authored seam guarantees deliberately become occupancy hints. Builder algorithms and types-25 remain unchanged.',
  limits: 'One exact corrected sample with swept sampled portal/room/court/actual-door yard routes. This is an intentional authored-content change, not a repair of the old exact brief. Other compound inputs and old saved embedded libraries retain their old behavior.'
};
assert.deepEqual(portal.errors, []);
assert.deepEqual(report.access.targetErrors, []);
assert.deepEqual(fillErrors, []);
if (map) assert.deepEqual(report.fullMapDefects, []);

function svg(zoom = false) {
  const b = createRegionMask(beforeBrief).bounds;
  const x = zoom ? site.x - 3 : b.x / size, y = zoom ? site.y - 3 : b.y / size;
  const w = zoom ? site.w + 6 : b.w / size, h = zoom ? site.h + 6 : b.h / size;
  const cells = cs => cs.map(c => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="#86efac"/>`).join('');
  const geometry = result => result.elements.flatMap(e => elementShapes(e)).map(s => `<polygon points="${outline(s).map(p => `${p.x / size},${p.y / size}`).join(' ')}" fill="#334155"/>`).join('');
  const portals = afterBrief.portals.map(p => `<line x1="${p.x}" y1="${p.y}" x2="${p.x + (p.axis === 'h' ? p.length : 0)}" y2="${p.y + (p.axis === 'v' ? p.length : 0)}" stroke="#dc2626" stroke-width=".35"/>`).join('');
  const targetDots = targets.map(t => `<circle cx="${t.point.x / size}" cy="${t.point.y / size}" r=".2" fill="#f97316"/>`).join('');
  const routeLines = targetRoutes.map(t => `<polyline points="${t.route.map(p => `${p.x / size},${p.y / size}`).join(' ')}" fill="none" stroke="#7c3aed" stroke-width=".08"/>`).join('');
  const panel = (shift, label, brief, result, extra = '') => `<g transform="translate(${shift} 0)"><text x="${x}" y="${y - 2}" font-size="${zoom ? 1 : 2}">${label}</text><g clip-path="url(#clip)"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#dbeafe"/>${cells(brief.fillCells)}${geometry(result)}${portals}${extra}</g></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${zoom ? 850 : 650}" viewBox="${x - 1} ${y - 5} ${w * 2 + 6} ${h + 14}"><defs><clipPath id="clip"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs><rect x="${x - 1}" y="${y - 5}" width="${w * 2 + 6}" height="${h + 14}" fill="white"/>${panel(0, 'Before: repeated internal clear margins; empty', beforeBrief, before)}${panel(w + 4, 'After: 22 rooms, court and two accessible gates', afterBrief, after, routeLines + targetDots)}<text x="${x}" y="${y + h + 3}" font-size="${zoom ? .6 : 2}">Green fill; pale blue clear margins; dark collision; red original portals; purple swept hunter routes; orange room/court/gate yard targets.</text></svg>`;
}
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'before-brief.json'), JSON.stringify(beforeBrief) + '\n');
await writeFile(resolve(out, 'after-brief.json'), JSON.stringify(afterBrief) + '\n');
await writeFile(resolve(out, 'after-result.json'), JSON.stringify(after) + '\n');
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(out, 'preview.svg'), svg());
await writeFile(resolve(out, 'ring.svg'), svg(true));
console.log(JSON.stringify({ out, ...report }, null, 2));
