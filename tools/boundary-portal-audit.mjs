#!/usr/bin/env node
/** Read-only #361 evidence: every cover, plant and park region past 32 portals, where the
 * builders swap their route protection for `boundaryBoxFilter`, with swept portal access of
 * the built geometry. Sources: the chain sweep's cases and the first maps of the 24x12 and
 * 36x18 libraries. Evidence for the #361 record in docs 42, not maintained tooling.
 *
 * node tools/boundary-portal-audit.mjs [--seeds=20] [--out=test-results/361-boundary.json]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { bundledLibrary, chainParams } from '../map/chain.ts';
import { placement } from '../map/macro/src/chain/placement.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { sweepCases } from '../map/tools/sweep.mts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(out|seeds)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use [--seeds=20] [--out=test-results/361-boundary.json]');
  return [match[1], match[2]];
}));
const out = resolve(args.get('out') ?? 'test-results/361-boundary.json'), seeds = Number(args.get('seeds') ?? 20);
const TYPES = new Set(['cover', 'plant', 'park']);
/** Sweep seeds run 1 to count, as `runCase` names them; the library maps run 0 to count - 1. */
const sources = [
  ...sweepCases().map(c => ({ id: c.id, params: c.params, seedPrefix: c.seedPrefix, first: 1, count: c.count })),
  { id: 'library-24x12', params: { mode: 'game', zoneWidth: 24, zoneHeight: 12 }, seedPrefix: 'issue361', first: 0, count: seeds },
  { id: 'library-36x18', params: { mode: 'game', zoneWidth: 36, zoneHeight: 18 }, seedPrefix: 'issue361', first: 0, count: seeds },
];
const regions = [];
for (const source of sources) for (let i = source.first; i < source.first + source.count; i++) {
  const seed = `${source.seedPrefix}-${i}`, params = chainParams(source.params), library = bundledLibrary(params);
  const layout = placement(seed, params, library);
  for (const brief of mapViews({ layout, library, cellSize: 48, results: [] }).briefs) {
    if (!TYPES.has(brief.type) || brief.portals.length <= 32) continue;
    const started = performance.now(), result = buildRegion(brief), ms = performance.now() - started;
    const reach = validatePortalReach({ ...brief, blockers: result.elements.flatMap(e => elementShapes(e)) });
    regions.push({ case: `${source.id}/${seed}`, id: brief.id, type: brief.type, cells: brief.cells.length,
      portals: brief.portals.length, elements: result.elements.length, buildMs: Math.round(ms), routes: reach.routes.length, errors: reach.errors });
    console.error(`${source.id}/${seed} ${brief.id} ${brief.type}: ${brief.portals.length} portals, ${result.elements.length} elements, ${reach.errors.length} errors`);
  }
}
const byType = Object.fromEntries([...TYPES].map(type => {
  const own = regions.filter(r => r.type === type);
  return [type, { regions: own.length, withErrors: own.filter(r => r.errors.length).length, errors: own.reduce((n, r) => n + r.errors.length, 0),
    maxPortals: Math.max(0, ...own.map(r => r.portals)), maxCells: Math.max(0, ...own.map(r => r.cells)) }];
}));
const report = { audit: 'boundary-portals-361-2', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyPaths: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  contentVersion: REGION_TYPES_VERSION, seeds, regions: regions.length, byType, samples: regions };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
