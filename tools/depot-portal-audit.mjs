#!/usr/bin/env node
/** Read-only #347 evidence: every depot past 32 portals in the chain sweep's cases, with its
 * warehouses and sampled swept portal access under the current depot builder. Run once per
 * builder revision and compare the reports. Evidence for the #347 record in docs 42, not
 * maintained tooling.
 *
 * node tools/depot-portal-audit.mjs [--out=test-results/347-depots.json]
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
  const match = /^--(out)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use [--out=test-results/347-depots.json]');
  return [match[1], match[2]];
}));
const out = resolve(args.get('out') ?? 'test-results/347-depots.json');
const depots = [];
for (const sweepCase of sweepCases()) for (let i = 0; i < sweepCase.count; i++) {
  const seed = `${sweepCase.seedPrefix}-${i}`, params = chainParams(sweepCase.params), library = bundledLibrary(params);
  const layout = placement(seed, params, library);
  for (const brief of mapViews({ layout, library, cellSize: 48, results: [] }).briefs) {
    if (brief.type !== 'depot' || brief.portals.length <= 32) continue;
    const result = buildRegion(brief), reach = validatePortalReach({ ...brief, blockers: result.elements.flatMap(e => elementShapes(e)) });
    depots.push({ case: `${sweepCase.id}/${seed}`, id: brief.id, cells: brief.cells.length, portals: brief.portals.length,
      warehouses: result.manifest.warehouses ?? 0, rows: result.manifest.rows ?? 0, routes: reach.routes.length, errors: reach.errors });
    console.error(`${sweepCase.id}/${seed} ${brief.id}: ${brief.portals.length} portals, ${result.manifest.warehouses ?? 0} warehouses, ${reach.errors.length} errors`);
  }
}
const report = { audit: 'depot-portals-347-1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyPaths: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  contentVersion: REGION_TYPES_VERSION, depots: depots.length, filled: depots.filter(d => d.warehouses).length,
  withErrors: depots.filter(d => d.errors.length).length, errors: depots.reduce((n, d) => n + d.errors.length, 0), samples: depots };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
