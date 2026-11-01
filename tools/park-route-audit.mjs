#!/usr/bin/env node
/**
 * #750: park with frozen `protectedRoutes` against park whose placements push a live cord witness
 * (20.10), on one map per size, size-{12,24,36}-1. Briefs come from current generation; "before"
 * rebuilds the park briefs with the base commit's strategy, so both sides read the same briefs.
 *
 * Detour is measured on focused fixed pairs: portal to portal through each park whose result
 * changed, and from its first portal to up to four of its fill cells. Empty share and dead-end area
 * are the whole-map navigation measure on each side. Every changed region gets an independent
 * fill-constraint and thorough portal-reach proof and one reordered rebuild; each map gets
 * `checkMap` with diagnosis. Cost is builder calls only, three sequential paired passes under the
 * machine lock, with output equality checked outside the timer.
 *
 * `--fronts X` (#649) compares instead today's park with today's park given `hedgeFronts: X`, the
 * growth-helper experiment (42.30); `--base` is then unused.
 * `--type T` (#759) audits another strategy the same way, against its own file at `--base`
 * (rubble and plant, moved off frozen routes after park; 42.31; cover, ruins, depot, hall and market
 * after them, #787, 42.33).
 * Usage: node tools/park-route-audit.mjs [outDir] [--base REV] [--fronts X] [--type T]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { generate, checkMap } from '../map/tools/core.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapFrame } from '../map/micro/adapter.ts';
import { rng } from '../map/micro/random.ts';
import { measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';
import { measurePocketRoutes } from './experiments/park-pocket-routes.mjs';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { captureSourceProvenance } from './lib/source-provenance.mjs';
import { coveredSamples } from './lib/covered-samples.mjs';

const args = process.argv.slice(2), at = args.indexOf('--base');
const baseArg = at >= 0 ? args.splice(at, 2)[1] : undefined;
const frontsAt = args.indexOf('--fronts'), fronts = frontsAt >= 0 ? Number(args.splice(frontsAt, 2)[1]) : undefined;
if (fronts !== undefined && !(fronts > 0 && fronts <= 1)) throw new Error('--fronts takes a chance above 0, at most 1.');
const typeAt = args.indexOf('--type'), type = typeAt >= 0 ? args.splice(typeAt, 2)[1] : 'park';
const STRATEGIES = { park: 'buildPark', rubble: 'buildRubble', plant: 'buildPlant',
  cover: 'buildCover', ruins: 'buildRuins', depot: 'buildDepot', hall: 'buildHall', market: 'buildMarket' };
const ROLLOUT = ['cover', 'ruins', 'depot', 'hall', 'market'];
if (!STRATEGIES[type]) throw new Error(`--type takes one of ${Object.keys(STRATEGIES).join(', ')}.`);
if (fronts !== undefined && type !== 'park') throw new Error('--fronts is park only.');
const issue = ROLLOUT.includes(type) ? 787 : type !== 'park' ? 759 : fronts === undefined ? 750 : 649;
const base = at >= 0 ? baseArg : type === 'park' ? '8eb3c58' : ROLLOUT.includes(type) ? '5e30b4b' : '3fbd082';
const dir = args[0] ?? `docs/reports/issue-${issue}${type === 'park' ? '' : `-${type}`}`;
mkdirSync(dir, { recursive: true }); mkdirSync('test-results', { recursive: true });
// Pinned first, so uncommitted sources fail before the long run rather than after it.
const provenance = await captureSourceProvenance(['map/micro/strategies/park.ts', 'map/micro/strategies/park-pocket.ts',
  'map/micro/strategies/scatter.ts', 'map/micro/prospective-parcels.ts', 'map/micro/cord-witness.ts', 'map/micro/diagnose.ts',
  'map/micro/region-types.ts', 'map/micro/growth.ts', 'map/micro/placeables/park-hedge-block.ts', 'tools/park-route-audit.mjs', 'tools/experiments/park-pocket-routes.mjs', 'tools/lib/covered-samples.mjs',
  ...type === 'park' ? [] : [`map/micro/strategies/${type}.ts`, 'map/micro/hint-walls.ts', 'map/micro/strategies/infill.ts']]);

// #750: the base strategy, with its imports resolved to today's modules. Only park.ts changes its
// placement path; `protectedRoutes` resolves as below, and the pocket's commit never
// fails on a frozen-route canvas, so the base build is the base commit's.
// #649: today's park on both sides, the after side with hedge fronts.
let before = buildRegion, build = buildRegion;
if (fronts === undefined) {
  // #787 retired `protectedRoutes` from scatter; a base that reads it gets the same function,
  // kept for tools in the frozen-routes module.
  const source = execFileSync('git', ['show', `${base}:map/micro/strategies/${type}.ts`], { encoding: 'utf8' })
    .replace(/import \{([^}]*)protectedRoutes,? ?([^}]*)\} from '\.\/scatter\.ts';/, (_, a, b) =>
      `import {${a}${b}} from './scatter.ts';
import { frozenRoutes as protectedRoutes } from '../experiments/frozen-routes.ts';`)
    .replace(/from '([^']+)'/g, (_, spec) => `from '${pathToFileURL(resolve('map/micro/strategies', spec)).href}'`);
  writeFileSync(`test-results/issue-${issue}-before-${type}.mts`, source);
  before = (await import(pathToFileURL(resolve(`test-results/issue-${issue}-before-${type}.mts`)).href))[STRATEGIES[type]];
} else build = brief => buildRegion({ ...brief, parameters: { ...brief.parameters, hedgeFronts: fronts } });

const solid = region => region.elements.some(e => elementShapes(e, true).length);
const obstacles = region => region.elements.flatMap(e => elementShapes(e, true));

/** Fixed endpoints through one park: every portal pair's middle stands, and its first portal to a few fill cells. */
function focusedPairs(brief, origin) {
  const at = p => ({ x: p.x + origin.x, y: p.y + origin.y });
  const middles = portalStands(brief).map(s => s.points[Math.floor(s.points.length / 2)]).filter(Boolean);
  const pairs = [];
  for (let a = 0; a < middles.length; a++) for (let b = a + 1; b < middles.length; b++)
    pairs.push({ category: 'portal-portal', from: at(middles[a]), to: at(middles[b]) });
  const size = brief.cellSize;
  if (middles.length) for (const cell of rng(brief.seed, `${brief.id}:audit-750`).shuffle([...brief.fillCells]).slice(0, 4))
    pairs.push({ category: 'portal-interior', from: at(middles[0]), to: at({ x: (cell.x + .5) * size, y: (cell.y + .5) * size }) });
  return pairs;
}

const maps = [], timings = [], examples = [];
const { release } = await acquireMachineLock('bench');
try {
  for (const width of [12, 24, 36]) {
    const seed = `size-${width}-1`;
    const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
    console.error(`#${issue} audit: ${seed}`);
    const after = generate(seed, params, undefined, 48), old = structuredClone(after);
    const indices = after.results.flatMap((r, i) => r.brief.type === type ? [i] : []);
    for (const i of indices) old.results[i] = before(after.results[i].brief);
    if (fronts !== undefined) for (const i of indices) after.results[i] = build(after.results[i].brief);

    for (const i of indices) assert.deepEqual(build(after.results[i].brief), after.results[i]);
    const passes = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      let start = performance.now();
      for (const i of indices) before(after.results[i].brief);
      const beforeMs = performance.now() - start;
      start = performance.now();
      for (const i of indices) build(after.results[i].brief);
      passes.push({ beforeMs, afterMs: performance.now() - start });
    }
    timings.push({ seed, briefs: indices.length, passes });

    const changed = indices.filter(i => JSON.stringify(old.results[i]) !== JSON.stringify(after.results[i]));
    for (const i of changed) {
      const region = after.results[i], b = region.brief, blockers = obstacles(region);
      assert.deepEqual(validateFillConstraints(b, blockers), [], `${b.id} fill`);
      const reach = validatePortalReach({ ...b, blockers }, { search: 'thorough' });
      assert.ok(reach.valid, `${b.id} reach ${reach.errors}`);
      const reordered = { ...b, cells: [...b.cells].reverse(), fillCells: [...b.fillCells].reverse(), clearCells: [...b.clearCells].reverse(),
        zones: b.zones.map(z => ({ ...z, cells: [...z.cells].reverse() })) };
      const again = build(reordered);
      assert.deepEqual(again.elements, region.elements, `${b.id} reordered`); assert.deepEqual(again.loot, region.loot);
    }
    const checks = { before: checkMap(old, { diagnose: true }), after: checkMap(after, { diagnose: true }) };
    for (const [side, check] of Object.entries(checks)) assert.ok(check.valid, `${seed} ${side}: ${JSON.stringify(check.defects)} ${JSON.stringify(check.brokenPromises)}`);

    // Park content over every park brief, both sides.
    const content = side => {
      let fill = 0, covered = 0, pieces = 0, empty = 0;
      for (const i of indices) {
        const region = side.results[i];
        fill += region.brief.fillCells.length; pieces += region.elements.length;
        covered += coveredSamples(region.brief.fillCells, region.brief.cellSize, obstacles(region));
        if (!solid(region)) empty++;
      }
      return { parks: indices.length, fillCells: fill, coveredFillShare: covered / fill, pieces, geometryEmpty: empty };
    };

    // Focused fixed pairs through the changed parks, the same endpoints on both maps.
    const { origin } = builtMapFrame(composeRegions(after.results));
    const focused = changed.flatMap(i => focusedPairs(after.results[i].brief, origin).map(p => ({ ...p, region: after.results[i].brief.id })));
    const pairs = { contestant: focused, hunter: focused };
    const fixedBefore = measurePocketRoutes(old, pairs), fixedAfter = measurePocketRoutes(after, pairs);
    const navigation = [measureNavigationStructure(old), measureNavigationStructure(after)];
    const roles = fixedAfter.roles.map(role => {
      const was = fixedBefore.roles.find(r => r.body === role.body), struct = navigation.map(m => m.roles.find(r => r.body === role.body));
      const sum = (m, f) => m.regions.reduce((t, r) => t + r[f], 0);
      const byCategory = category => ({ before: summarizeRoutes(was.samples.filter(s => s.category === category)),
        after: summarizeRoutes(role.samples.filter(s => s.category === category)) });
      return { body: role.body, fixedPairs: role.samples.length,
        changedRoutes: role.samples.filter((s, k) => s.status !== was.samples[k].status || s.length !== was.samples[k].length).length,
        lostRoutes: role.samples.filter((s, k) => was.samples[k].status === 'complete' && s.status !== 'complete').length,
        routes: { all: { before: summarizeRoutes(was.samples), after: summarizeRoutes(role.samples) },
          portalPortal: byCategory('portal-portal'), portalInterior: byCategory('portal-interior') },
        emptyShare: struct.map(m => sum(m, 'emptySamples') / sum(m, 'walkableSamples')),
        deadEndArea: struct.map(m => m.deadEndArea), walkableArea: struct.map(m => m.walkableArea) };
    });
    // Final targets on the after map's own endpoints: core routes must all complete.
    const finalTargets = navigation[1].roles.map(role => {
      const byCategory = {};
      for (const s of role.samples) (byCategory[s.category] ??= {})[s.status] = ((byCategory[s.category] ??= {})[s.status] ?? 0) + 1;
      const failures = role.samples.filter(s => s.status !== 'complete');
      for (const s of failures) assert.ok(!['spawn-exit', 'spawn-charger'].includes(s.category), `${seed} ${role.body}: core target ${s.category} ${s.status}`);
      return { body: role.body, pairs: role.samples.length, byCategory: Object.fromEntries(Object.entries(byCategory).sort()), failures: failures.length };
    });
    // The changed park with the largest portal-to-portal detour after, as a witness.
    const hunter = fixedAfter.roles.find(r => r.body === 'hunter').samples;
    const longest = hunter.filter(s => s.category === 'portal-portal' && s.ratio !== null).toSorted((a, b) => b.ratio - a.ratio)[0];
    if (longest) {
      const i = after.results.findIndex(r => r.brief.id === longest.region);
      examples.push({ seed, witness: 'longest-portal-detour', id: longest.region, ratio: longest.ratio, brief: after.results[i].brief, before: old.results[i], after: after.results[i] });
    }
    maps.push({ seed, params, regions: after.results.length, parkBriefs: indices.length, changed: changed.length,
      content: { before: content(old), after: content(after) },
      coreElements: [checks.before.coreElements, checks.after.coreElements], roles, finalTargets });
  }
} finally { release(); }

const summary = { issue, type, ...(fronts === undefined ? { base } : { hedgeFronts: fronts }), build: REGION_TYPES_VERSION, node: process.version, provenance,
  panel: 'size-{12,24,36}-1, generate(seed, params, undefined, 48)', maps, timings };
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
writeFileSync(`${dir}/examples.json.gz`, gzipSync(JSON.stringify(examples) + '\n'));
console.log(JSON.stringify(maps.map(m => ({ seed: m.seed, changed: m.changed, content: m.content,
  routes: m.roles.map(r => ({ body: r.body, ...r.routes.all, emptyShare: r.emptyShare, deadEndArea: r.deadEndArea })) })), null, 1));
