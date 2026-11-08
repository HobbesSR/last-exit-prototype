#!/usr/bin/env node
/**
 * #849: one library's maps on #688's panel and a seed batch, for comparing two libraries. Read-only
 * apart from `--out` and `--save`. Per map: generation time, macro portals and one-portal regions,
 * how often the fill placed each tile design, and 51.10's long across-map detour and dead-end
 * area for both bodies. Physical blocked share is `edge-clearance.mts --maps DIR` over the
 * maps `--save` keeps. Results: 42.37.
 *
 *   node map/tools/library-comparison.mts [--library FILE] [--widths 12,24,36] [--seeds 1,2,3]
 *     [--sparse FILL/SET_PIECES] [--macro] [--save DIR] [--out FILE [--replace]]
 *
 * `--sparse` takes each size's bundled library through #851's experimental sparse sides
 * (`map/sparse-sides.ts`), for example `--sparse bundled/alternate` (42.40).
 *
 * `--macro` stops at the briefs (`generateMacro`): portals, one-portal regions and fill need only
 * the Layout and its views, so it skips building and the navigation measures, which need geometry.
 *
 * Without `--library`, each map takes the bundled library for its size. A `--library` file is a
 * top-level library for one zone size, whose modules sit beside it (`library-files.mts`); widths
 * it is not authored for are refused. Generation time here is indicative only: the run also
 * measures, so use `tools/generation-time.mjs` under the bench lock for cost.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { CHAIN_LIBRARIES, generate, generateMacro, sparseSidesLibrary } from './core.ts';
import type { FillSides, SetPieceSides } from './core.ts';
import { readLibraryFile } from './library-files.mts';
import { chainMapToJson } from '../macro/src/chain/saving.ts';
import { mapViews } from '../macro/src/chain/map.ts';
import { measureNavigationStructure } from './navigation-structure.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1]!.startsWith('--')) throw new Error(`${name} requires a value`);
  return process.argv[i + 1]!;
};
const widths = arg('--widths', '12,24,36').split(',').map(Number);
const seeds = arg('--seeds', '1').split(',').map(Number);
const macroOnly = process.argv.includes('--macro');
const libraryFile = arg('--library', ''), save = arg('--save', ''), out = arg('--out', '');
if (out && existsSync(out) && !process.argv.includes('--replace')) throw new Error(`${out} exists; pass --replace`);
const sparse = arg('--sparse', '');
if (sparse && libraryFile) throw new Error('--sparse and --library are exclusive');
const library = libraryFile ? readLibraryFile(libraryFile) as { zoneWidth: number } : undefined;
const [fillSides, setPieceSides] = sparse.split('/') as [FillSides, SetPieceSides];
const FILL_SIDES: readonly string[] = ['bundled', 'sparse'], SET_PIECE_SIDES: readonly string[] = ['bundled', 'inner', 'alternate', 'face'];
if (sparse && (sparse.split('/').length !== 2 || !FILL_SIDES.includes(fillSides) || !SET_PIECE_SIDES.includes(setPieceSides)))
  throw new Error(`--sparse takes FILL/SET_PIECES, fill one of ${FILL_SIDES.join(', ')} and set pieces one of ${SET_PIECE_SIDES.join(', ')}; got ${sparse}`);
const libraryFor = (width: number) => !sparse ? library
  : sparseSidesLibrary(CHAIN_LIBRARIES.find(bundled => bundled.zoneWidth === width)!, { fill: fillSides, setPieces: setPieceSides });
if (library && widths.some(w => w !== library.zoneWidth)) throw new Error(`${libraryFile} is authored for width ${library.zoneWidth} only`);
if (save) mkdirSync(save, { recursive: true });
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
type Detour = { median: number | null; p90: number | null; shareAbove1_5: number | null; complete: number };

const maps = [];
for (const width of widths) for (const n of seeds) {
  const seed = `size-${width}-${n}`;
  const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
  const t0 = performance.now();
  const map = macroOnly ? generateMacro(seed, params, libraryFor(width)) : generate(seed, params, libraryFor(width), 48);
  const seconds = (performance.now() - t0) / 1000;
  const json = chainMapToJson(map, macroOnly ? { results: false } : {}); // macro: the Layout alone
  if (save) writeFileSync(`${save}/${seed}.json.gz`, gzipSync(json));
  const { regions } = mapViews(map);
  const portalsOf = new Map<string, number>();
  for (const portal of regions.portals) for (const id of [portal.a, portal.b]) portalsOf.set(id, (portalsOf.get(id) ?? 0) + 1);
  // The fill is every slot outside a set piece instance (51.3).
  const pieced = new Set(map.layout.setPieces.flatMap(instance => instance.slots.map(s => `${s.col},${s.row}`)));
  const fill: Record<string, number> = {};
  for (const slot of map.layout.slots) if (!pieced.has(`${slot.col},${slot.row}`)) fill[slot.design] = (fill[slot.design] ?? 0) + 1;
  const bodies = macroOnly ? null : Object.fromEntries(measureNavigationStructure(map).roles.map(role => {
    const long = (role.detour as Record<string, Detour>)['across-map/long:>=24-cells'];
    return [role.body, { longAcrossMap: long ? { median: long.median, p90: long.p90, shareAbove1_5: long.shareAbove1_5, routes: long.complete } : null,
      walkableArea: role.walkableArea, deadEndArea: role.deadEndArea, deadEndShare: role.walkableArea ? role.deadEndArea / role.walkableArea : null,
      pocketCuts: role.pocketCuts.length }];
  }));
  maps.push({ seed, digest: hash(json), seconds: +seconds.toFixed(2), library: map.library.name, fingerprint: map.layout.library,
    regions: regions.regions.length, portals: regions.portals.length,
    portalLength: regions.portals.reduce((sum, portal) => sum + portal.length, 0),
    onePortalRegions: regions.regions.filter(region => portalsOf.get(region.id) === 1).length,
    fillSlots: Object.values(fill).reduce((a, b) => a + b, 0),
    fill: Object.fromEntries(Object.entries(fill).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))),
    bodies });
  console.error(`${seed}: generated in ${seconds.toFixed(1)} s, measured`);
}
const report = { version: 'library-comparison-1', definitions: 'docs/51.10-measurement.md', results: sparse ? 'docs/42.40-sparse-sides-experiment.md' : 'docs/42.37-matched-adoption.md',
  revision: git('rev-parse', 'HEAD'), library: libraryFile || (sparse ? `sparse ${sparse}` : 'bundled'), stages: macroOnly ? 'macro' : 'built', node: process.version, maps };
if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n'); else console.log(JSON.stringify(report, null, 1));
