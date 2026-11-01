#!/usr/bin/env node
/**
 * #749: per-builder census over the real briefs of the #716/#717 panel, size-{12,24,36}-{1,2,3}.
 * Per type: region sizes, how many regions hold no collision geometry, how much fill obstacles
 * cover, and how much of each region clear margins and `protectedRoutes` take. Per mechanism:
 * how often it fires, from manifests, element labels, and two observers where those can't tell
 * (cover's lattice from its #717 fallback; hut and compound yard handoff outcomes).
 *
 * Builders are not rerun for the census itself: `generate` already built every brief once, and the
 * maps are cached in test-results/ under a digest of every generation input. No navigation, map
 * checks or timing.
 * Usage: node tools/builder-census.mjs [outDir]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { generate } from '../map/tools/core.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { elementShapes, createRegionMask } from '../map/micro/geometry.ts';
import { frozenRoutes as protectedRoutes } from '../map/micro/experiments/frozen-routes.ts';
import { sitedCover } from '../map/micro/strategies/cover.ts';
import { buildHutGeneration } from '../map/micro/strategies/hut.ts';
import { buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { captureSourceProvenance } from './lib/source-provenance.mjs';
import { coveredSamples, SAMPLES } from './lib/covered-samples.mjs';

const dir = process.argv[2] ?? 'docs/reports/issue-749';
const cache = 'test-results/issue-749';
mkdirSync(dir, { recursive: true }); mkdirSync(cache, { recursive: true });

/** How each strategy calls `protectedRoutes` (mode, and the portal limit above which it skips them). */
const ROUTED = { cover: ['root', 32], plant: ['root', 32], hall: ['root', Infinity],
  rubble: ['root', Infinity], ruins: ['root', Infinity], depot: ['nearby', Infinity], market: ['nearby', Infinity] };
const routeMode = brief => {
  const routed = ROUTED[brief.type];
  if (!routed) return null;
  return brief.portals.length <= routed[1] ? routed[0] : null;
};
/**
 * What a panel map depends on: the working tree's generation sources (macro, micro, kernel and the
 * shared core, tracked or not, as they stand on disk), the lockfiles, and Node. Any change misses
 * the cache, so a cached map never stands in for sources it wasn't made from.
 */
function generationDigest() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const files = [...new Set([...git('ls-files', '--', 'map', 'shared', 'package-lock.json'),
    ...git('ls-files', '--others', '--exclude-standard', '--', 'map', 'shared')])].sort();
  const hash = createHash('sha256').update(process.version);
  // Line endings follow the checkout, not the source.
  for (const file of files) if (existsSync(file))
    hash.update(`\0${file}\0`).update(readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'));
  return { digest: hash.digest('hex'), files: files.length };
}
const generation = generationDigest();

function panelMap(seed, width) {
  const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
  const key = { seed, params, cellSize: 48, build: REGION_TYPES_VERSION, generation: generation.digest };
  const file = `${cache}/${seed}.json.gz`;
  if (existsSync(file)) {
    const saved = JSON.parse(gunzipSync(readFileSync(file)));
    if (JSON.stringify(saved.key) === JSON.stringify(key)) return saved;
    console.error(`#749 census: ${seed} cache is stale; regenerating`);
  }
  const map = generate(seed, params, undefined, key.cellSize), saved = { key, results: map.results };
  writeFileSync(file, gzipSync(JSON.stringify(saved)));
  return saved;
}

/** A label's mechanism family: the last path segment without numbers, and the delegation route to it. */
function family(label) {
  const segments = String(label).split('/');
  const leaf = segments.at(-1).replace(/-\d+(?=-|$)/g, '').replace(/-[hv]$/, '').replace(/-(north|east|south|west)-(wall|debris)$/, '-$2');
  const via = segments.length > 1 ? segments[1].startsWith('delegate') ? 'delegate:' : `${segments[1].replace(/-\d+$/, '')}:` : '';
  return via + leaf;
}

const solid = region => region.elements.some(e => elementShapes(e, true).length);
const types = {};
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

const started = performance.now();
for (const width of [12, 24, 36]) for (const n of [1, 2, 3]) {
  const seed = `size-${width}-${n}`;
  console.error(`#749 census: ${seed}`);
  const map = panelMap(seed, width);
  for (const region of map.results) {
    const brief = region.brief, size = brief.cellSize, fill = brief.fillCells ?? brief.cells;
    const t = types[brief.type] ??= { regions: 0, cells: [], fill: [], totalCells: 0, totalFill: 0, empty: 0, emptyFill: 0,
      covered: 0, routed: 0, routeCovered: 0, routedFill: 0, mechanisms: {}, manifest: {}, outcomes: {} };
    t.regions++; t.cells.push(brief.cells.length); t.fill.push(fill.length);
    t.totalCells += brief.cells.length; t.totalFill += fill.length;
    const obstacles = region.elements.flatMap(e => elementShapes(e));
    if (!solid(region)) { t.empty++; t.emptyFill += fill.length; }
    t.covered += coveredSamples(fill, size, obstacles);
    const mode = fill.length ? routeMode(brief) : null;
    // A strategy that exits before protecting routes never asks for them, and may have no route to find.
    let routes;
    if (mode) try { routes = protectedRoutes(brief, brief.type, mode); } catch { bump(t.outcomes, 'no protected route (builder exits first)'); }
    if (routes) {
      t.routed++; t.routedFill += fill.length;
      t.routeCovered += coveredSamples(fill, size, routes);
    }

    // Manifest counters beyond the common ones: regions where each fired, and its total.
    for (const [key, value] of Object.entries(region.manifest))
      if (!['cells', 'structures', 'obstacles', 'gates', 'loot', 'coreElements'].includes(key) && value > 0) {
        bump(t.manifest, `${key}.regions`); bump(t.manifest, `${key}.total`, value);
      }
    // Label families: regions holding each, so delegated and decomposed children show by builder.
    for (const f of new Set(region.elements.map(e => family(e.label)))) bump(t.mechanisms, f);

    // Outcomes the result can't show.
    const outcome = o => bump(t.outcomes, o);
    if (brief.type === 'cover') {
      const lattice = sitedCover(brief).region.elements.length;
      outcome(lattice ? 'lattice' : region.elements.length ? 'fallback' : brief.portals.length > 32 ? 'empty, >32 portals' : 'empty');
    }
    if (brief.type === 'park') {
      const m = region.manifest;
      outcome(m.pockets ? 'pocket' : m.hedges || m.clumps ? 'lattice' : m.trees ? 'fallback' : 'empty');
    }
    if (brief.type === 'rubble') {
      const owned = createRegionMask(brief), span = Math.min(owned.bounds.w, owned.bounds.h) / size;
      if (!fill.length || brief.cells.length < 12 || span < 3) outcome('unfilledRegion exit');
    }
    // An empty density-driven region: would any density place something, or does nothing fit (42.27)?
    if (['cover', 'park', 'rubble'].includes(brief.type) && !solid(region) && fill.length)
      outcome(solid(buildRegion({ ...brief, parameters: { ...brief.parameters, density: 1 } })) ? 'empty: draw declined' : 'empty: no fit');
    if (brief.type === 'hut' || brief.type === 'compound') {
      const yards = [];
      (brief.type === 'hut' ? buildHutGeneration : buildCompoundGeneration)(brief, { observeYard: d => yards.push(d) });
      for (const yard of yards) {
        outcome(`yard: ${yard.outcome}`);
        if (yard.accepted) bump(t.outcomes, 'yard: patches accepted', yard.accepted);
        for (const [reason, count] of Object.entries(yard.refusals)) bump(t.outcomes, `yard refused: ${reason}`, count);
      }
    }
    if (!['open', 'cover', 'park', 'rubble'].includes(brief.type) && !solid(region))
      outcome(!fill.length ? 'empty, no fill' : region.coreElements.length ? 'empty: core elements only' : 'empty: unfilledRegion exit or nothing placed');
  }
}
const elapsed = (performance.now() - started) / 1000;

const quantile = (values, q) => { const s = values.toSorted((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const share = (a, b) => b ? Math.round(1000 * a / b) / 1000 : null;
const sorted = o => Object.fromEntries(Object.entries(o).sort());
const panelCells = Object.values(types).reduce((sum, t) => sum + t.totalCells, 0);
const byType = Object.fromEntries(Object.entries(types).sort(([, a], [, b]) => b.totalFill - a.totalFill).map(([type, t]) => [type, {
  regions: t.regions,
  cells: { p10: quantile(t.cells, .1), p50: quantile(t.cells, .5), p90: quantile(t.cells, .9), max: Math.max(...t.cells), total: t.totalCells },
  fill: { p10: quantile(t.fill, .1), p50: quantile(t.fill, .5), p90: quantile(t.fill, .9), max: Math.max(...t.fill), total: t.totalFill },
  panelCellShare: share(t.totalCells, panelCells), marginShare: share(t.totalCells - t.totalFill, t.totalCells),
  emptyRegions: t.empty, emptyShare: share(t.empty, t.regions), emptyFillShare: share(t.emptyFill, t.totalFill),
  coveredFillShare: share(t.covered, t.totalFill),
  routes: t.routed ? { regions: t.routed, fillShare: share(t.routeCovered, t.routedFill) } : null,
  manifest: sorted(t.manifest), mechanisms: sorted(t.mechanisms), outcomes: sorted(t.outcomes),
}]));

const sources = ['tools/builder-census.mjs', 'map/micro/region-types.ts', 'map/micro/strategies/scatter.ts', 'map/micro/strategies/cover.ts',
  'map/micro/strategies/park.ts', 'map/micro/strategies/hut.ts', 'map/micro/strategies/compound.ts', 'map/micro/yard-handoff.ts'];
const summary = { issue: 749, build: REGION_TYPES_VERSION, node: process.version, provenance: await captureSourceProvenance(sources),
  panel: 'size-{12,24,36}-{1,2,3}, generate(seed, params, undefined, 48)', generation, samplesPerCell: SAMPLES ** 2, seconds: Math.round(elapsed), byType };
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
console.log(`census ${Math.round(elapsed)} s; ${dir}/summary.json`);
