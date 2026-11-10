#!/usr/bin/env node
/**
 * #649: compare today's park with today's park given `hedgeFronts: X`, the growth-helper
 * experiment (42.30), on one map per size, size-{12,24,36}-1.
 * (Note: The former #750/#759/#787 base-commit comparison against frozen routes was retired with
 * the frozen-route control in #923; the tool is listed for the Track 4 tools sweep).
 *
 * Detour is measured on focused fixed pairs: portal to portal through each park whose result
 * changed, and from its first portal to up to four of its fill cells. Empty share and dead-end area
 * are the whole-map navigation measure on each side. Every changed region gets an independent
 * fill-constraint and thorough portal-reach proof and one reordered rebuild; each map gets
 * `checkMap` with diagnosis. Cost is builder calls only, three sequential paired passes under the
 * machine lock, with output equality checked outside the timer.
 *
 * Usage: node tools/park-route-audit.mjs [outDir] --fronts X
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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

const args = process.argv.slice(2);
const frontsAt = args.indexOf('--fronts'), fronts = frontsAt >= 0 ? Number(args.splice(frontsAt, 2)[1]) : undefined;
if (fronts === undefined) throw new Error('Usage: node tools/park-route-audit.mjs [outDir] --fronts X (frozen-route base comparison retired in #923).');
if (!(fronts > 0 && fronts <= 1)) throw new Error('--fronts takes a chance above 0, at most 1.');
const issue = 649, type = 'park';
const dir = args[0] ?? `docs/reports/issue-${issue}`;
mkdirSync(dir, { recursive: true }); mkdirSync('test-results', { recursive: true });
// Pinned first, so uncommitted sources fail before the long run rather than after it.
const provenance = await captureSourceProvenance(['map/micro/strategies/park.ts', 'map/micro/strategies/park-pocket.ts',
  'map/micro/strategies/scatter.ts', 'map/micro/prospective-parcels.ts', 'map/micro/cord-witness.ts', 'map/micro/diagnose.ts',
  'map/micro/region-types.ts', 'map/micro/growth.ts', 'map/micro/placeables/park-hedge-block.ts', 'tools/park-route-audit.mjs', 'tools/experiments/park-pocket-routes.mjs', 'tools/lib/covered-samples.mjs']);

// #649: today's park on both sides, the after side with hedge fronts.
const build = brief => buildRegion({ ...brief, parameters: { ...brief.parameters, hedgeFronts: fronts } });
const before = buildRegion;

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

const summary = { issue, type, hedgeFronts: fronts, build: REGION_TYPES_VERSION, node: process.version, provenance,
  panel: 'size-{12,24,36}-1, generate(seed, params, undefined, 48)', maps, timings };
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
writeFileSync(`${dir}/examples.json.gz`, gzipSync(JSON.stringify(examples) + '\n'));
console.log(JSON.stringify(maps.map(m => ({ seed: m.seed, changed: m.changed, content: m.content,
  routes: m.roles.map(r => ({ body: r.body, ...r.routes.all, emptyShare: r.emptyShare, deadEndArea: r.deadEndArea })) })), null, 1));
