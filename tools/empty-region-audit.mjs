#!/usr/bin/env node
/**
 * #717: geometry-empty regions on the fixed size-{12,24,36}-{1,2,3} panel, before and after
 * cover's and park's bounded per-cell fallback. Briefs come from current generation; "before"
 * rebuilds the cover and park briefs with the base commit's strategies, so both sides read the
 * same briefs. Route endpoints are the before map's own samples, measured again unchanged after.
 * Usage: node tools/empty-region-audit.mjs [outDir] [--base REV]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, checkMap } from '../map/tools/core.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { measureNavigationStructure, summarizeRoutes } from '../map/tools/navigation-structure.ts';
import { measurePocketRoutes } from './experiments/park-pocket-routes.mjs';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';
import { captureSourceProvenance } from './lib/source-provenance.mjs';

const args = process.argv.slice(2), at = args.indexOf('--base');
const base = at >= 0 ? args.splice(at, 2)[1] : 'e4811a6';
const dir = args[0] ?? 'docs/reports/issue-717';
const ADOPTERS = ['cover', 'park'], CORE = ['arrival', 'departure', 'charging', 'transit'];
mkdirSync(dir, { recursive: true }); mkdirSync('test-results', { recursive: true });

// The base strategies, with their imports resolved to today's modules. Only cover.ts, park.ts
// and scatter.ts change here, and scatter keeps every export the base strategies use.
const loadBase = async file => {
  const source = execFileSync('git', ['show', `${base}:map/micro/strategies/${file}`], { encoding: 'utf8' })
    .replace(/from '([^']+)'/g, (_, spec) => `from '${pathToFileURL(resolve('map/micro/strategies', spec)).href}'`);
  const out = `test-results/issue-717-before-${file.replace('.ts', '.mts')}`;
  writeFileSync(out, source);
  return import(pathToFileURL(resolve(out)).href);
};
const before = { cover: (await loadBase('cover.ts')).buildCover, park: (await loadBase('park.ts')).buildPark };

const solid = region => region.elements.some(e => elementShapes(e, true).length);
const area = region => ({ cells: region.brief.cells.length, fill: region.brief.fillCells.length });
/** Why a region has no collision geometry. Reasons come from inputs and reruns, not element counts. */
function reason(region, rebuild) {
  const { type } = region.brief;
  if (type === 'open') return 'intentional-open';
  if (!region.brief.fillCells.length) return 'no-usable-fill';
  if (CORE.includes(type)) return region.coreElements.length ? 'core-only' : 'core-region-no-content';
  if (!ADOPTERS.includes(type)) return 'not-adopted';
  // Would any density place something? If not, nothing of this type fits; else the draw declined.
  return solid(rebuild({ ...region.brief, parameters: { ...region.brief.parameters, density: 1 } })) ? 'stochastic-no-placement' : 'no-fit';
}
const tally = (rows, key) => {
  const out = {};
  for (const row of rows) {
    const k = key(row), t = out[k] ??= { regions: 0, cells: 0, fill: 0 };
    t.regions++; t.cells += row.cells; t.fill += row.fill;
  }
  return Object.fromEntries(Object.entries(out).sort());
};

const maps = [], examples = [], timings = [];
const { release } = await acquireMachineLock('bench');
try {
  for (const width of [12, 24, 36]) for (const n of [1, 2, 3]) {
    const seed = `size-${width}-${n}`;
    const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
    console.error(`#717 audit: ${seed}`);
    const after = generate(seed, params, undefined, 48), old = structuredClone(after);
    const indices = after.results.flatMap((r, i) => ADOPTERS.includes(r.brief.type) ? [i] : []);
    for (const i of indices) old.results[i] = before[after.results[i].brief.type](after.results[i].brief);

    // Fallback cost: the base and current builders over the same briefs, three sequential passes.
    for (const i of indices) buildRegion(after.results[i].brief);
    const passes = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      let start = performance.now();
      for (const i of indices) before[after.results[i].brief.type](after.results[i].brief);
      const beforeMs = performance.now() - start;
      start = performance.now();
      for (const i of indices) assert.deepEqual(buildRegion(after.results[i].brief), after.results[i]);
      passes.push({ beforeMs, afterMs: performance.now() - start });
    }
    timings.push({ seed, briefs: indices.length, passes });

    const changed = indices.filter(i => JSON.stringify(old.results[i]) !== JSON.stringify(after.results[i]));
    for (const i of changed) {
      const region = after.results[i], b = region.brief;
      assert.ok(!solid(old.results[i]) && solid(region), `${b.id}: only primary-empty regions change`);
      // Independent final checks: inherited fill constraints and thorough portal reach.
      const blockers = region.elements.flatMap(e => elementShapes(e, true));
      const fillErrors = validateFillConstraints(b, blockers), reach = validatePortalReach({ ...b, blockers }, { search: 'thorough' });
      assert.deepEqual(fillErrors, [], `${b.id} fill`); assert.ok(reach.valid, `${b.id} reach ${reach.errors}`);
      const reordered = { ...b, cells: [...b.cells].reverse(), fillCells: [...b.fillCells].reverse(), clearCells: [...b.clearCells].reverse(),
        portals: [...b.portals].reverse(), zones: b.zones.map(z => ({ ...z, cells: [...z.cells].reverse() })) };
      const again = buildRegion(reordered);
      assert.deepEqual(again.elements, region.elements, `${b.id} reordered`); assert.deepEqual(again.loot, region.loot);
    }
    const checks = { before: checkMap(old, { diagnose: true }), after: checkMap(after, { diagnose: true }) };
    for (const [side, check] of Object.entries(checks)) assert.ok(check.valid, `${seed} ${side}: ${JSON.stringify(check.defects)} ${JSON.stringify(check.brokenPromises)}`);

    const rows = side => side.results.flatMap((region, i) => solid(region) ? [] : [{ index: i, id: region.brief.id, type: region.brief.type,
      portals: region.brief.portals.length, ...area(region),
      reason: reason(region, b => (side === old ? before[b.type] : buildRegion)(b)) }]);
    const emptyBefore = rows(old), emptyAfter = rows(after);
    for (const i of changed.slice(0, 2)) examples.push({ seed, id: after.results[i].brief.id, type: after.results[i].brief.type,
      brief: after.results[i].brief, before: old.results[i], after: after.results[i] });
    // The narrowest region the fallback filled, and one it could not, as boundary witnesses.
    const narrow = changed.toSorted((a, b) => after.results[a].brief.fillCells.length - after.results[b].brief.fillCells.length)[0];
    if (narrow !== undefined && width === 36) examples.push({ seed, witness: 'narrowest-filled', id: after.results[narrow].brief.id,
      brief: after.results[narrow].brief, before: old.results[narrow], after: after.results[narrow] });
    const refused = emptyAfter.find(r => r.reason === 'no-fit');
    if (refused && width === 36) examples.push({ seed, witness: 'no-fit', id: refused.id, brief: after.results[refused.index].brief, after: after.results[refused.index] });

    // Navigation: before's own endpoint pairs, unchanged, measured on both maps.
    const navigation = measureNavigationStructure(old), navAfter = measureNavigationStructure(after);
    const pairs = Object.fromEntries(navigation.roles.map(role => [role.body, role.samples.map(s => ({ category: s.category, stratum: s.stratum, from: s.from, to: s.to }))]));
    const fixedBefore = measurePocketRoutes(old, pairs), fixedAfter = measurePocketRoutes(after, pairs);
    const roles = fixedAfter.roles.map(role => {
      const was = fixedBefore.roles.find(r => r.body === role.body), struct = [navigation, navAfter].map(m => m.roles.find(r => r.body === role.body));
      assert.deepEqual(role.samples.map(s => [s.from, s.to]), was.samples.map(s => [s.from, s.to]));
      const changedRoutes = role.samples.filter((s, k) => s.status !== was.samples[k].status || s.length !== was.samples[k].length);
      const sum = (m, f) => m.regions.reduce((t, r) => t + r[f], 0);
      return { body: role.body, fixedPairs: role.samples.length, changedRoutes: changedRoutes.length,
        lostRoutes: role.samples.filter((s, k) => was.samples[k].status === 'complete' && s.status !== 'complete').length,
        routesBefore: summarizeRoutes(was.samples), routesAfter: summarizeRoutes(role.samples),
        emptyShare: struct.map(m => sum(m, 'emptySamples') / sum(m, 'walkableSamples')),
        deadEndArea: struct.map(m => m.deadEndArea), walkableArea: struct.map(m => m.walkableArea) };
    });
    maps.push({ seed, params, regions: after.results.length, adopterBriefs: indices.length, changed: changed.length,
      emptyBefore: { byReason: tally(emptyBefore, r => r.reason), byTypeReason: tally(emptyBefore, r => `${r.type}/${r.reason}`) },
      emptyAfter: { byReason: tally(emptyAfter, r => r.reason), byTypeReason: tally(emptyAfter, r => `${r.type}/${r.reason}`) },
      pieces: changed.reduce((t, i) => t + after.results[i].elements.length, 0),
      lootBefore: changed.reduce((t, i) => t + old.results[i].loot.length, 0), lootAfter: changed.reduce((t, i) => t + after.results[i].loot.length, 0),
      coreElements: [checks.before.coreElements, checks.after.coreElements], roles });
  }
} finally { release(); }

const sum = key => {
  const out = {};
  for (const map of maps) for (const side of ['emptyBefore', 'emptyAfter']) for (const [k, v] of Object.entries(map[side][key])) {
    const t = (out[k] ??= { before: { regions: 0, cells: 0, fill: 0 }, after: { regions: 0, cells: 0, fill: 0 } })[side === 'emptyBefore' ? 'before' : 'after'];
    t.regions += v.regions; t.cells += v.cells; t.fill += v.fill;
  }
  return Object.fromEntries(Object.entries(out).sort());
};
const sources = ['map/micro/strategies/scatter.ts', 'map/micro/strategies/cover.ts', 'map/micro/strategies/park.ts', 'map/micro/region-types.ts',
  'tools/empty-region-audit.mjs', 'tools/experiments/park-pocket-routes.mjs'];
const summary = { issue: 717, base, build: REGION_TYPES_VERSION, node: process.version, provenance: await captureSourceProvenance(sources),
  panel: 'size-{12,24,36}-{1,2,3}, generate(seed, params, undefined, 48)', totals: { byReason: sum('byReason'), byTypeReason: sum('byTypeReason') },
  maps, timings };
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1) + '\n');
writeFileSync(`${dir}/examples.json`, JSON.stringify(examples) + '\n');
console.log(JSON.stringify(summary.totals.byReason, null, 1));
