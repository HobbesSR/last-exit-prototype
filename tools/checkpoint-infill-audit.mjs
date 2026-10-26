// #575: compare checkpoint content on identical current-library briefs against a pinned strategy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildCheckpoint } from '../map/micro/strategies/checkpoint.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { cellsOf } from '../tests/helpers/cells.js';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? 'f775fe7';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/checkpoint.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
// Only the checkpoint strategy is historical: all shared geometry/placeables and library inputs
// are current, deliberately isolating this adoption from intervening library changes.
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'checkpoint-infill-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildCheckpoint;
  const lootReachSampleLimit = 20;
  /** Select spatially spread baseline loot sites, deterministically, with a bounded sample. */
  function spreadLoot(sites) {
    if (!sites.length) return [];
    const selected = [sites[0]];
    const remaining = new Set(sites.slice(1));
    while (selected.length < lootReachSampleLimit && remaining.size) {
      let best, bestDistance = -1;
      for (const site of remaining) {
        const distance = Math.min(...selected.map(chosen => (site.x - chosen.x) ** 2 + (site.y - chosen.y) ** 2));
        if (distance > bestDistance) { best = site; bestDistance = distance; }
      }
      selected.push(best);
      remaining.delete(best);
    }
    return selected;
  }
  /**
   * Independent grid flood over hunter-sized standing cells. Integer cell intersections are
   * nodes only when the hunter's full disc fits there; cardinal edges use swept-body clearance
   * check as the production route validator. The first portal's first stand anchors the flood.
   */
  function freeAreaReach(brief, blockers, anchorOverride) {
    const access = createAccessMask(brief), size = brief.cellSize, radius = hunterClearance(size);
    const owned = [...brief.cells].sort((a, b) => a.y - b.y || a.x - b.x);
    const roots = portalStands(brief)[0]?.points;
    const nodePoint = cell => ({ x: (cell.x + 1) * size, y: (cell.y + 1) * size });
    const nodeKey = cell => `${cell.x + 1},${cell.y + 1}`;
    const walkable = new Map();
    const free = cell => {
      const id = nodeKey(cell);
      if (!walkable.has(id)) {
        const point = nodePoint(cell);
        walkable.set(id, travelClear(access, blockers, point, point, radius));
      }
      return walkable.get(id);
    };
    const nodesByKey = new Map(owned.map(cell => [nodeKey(cell), cell]));
    const reached = new Set(), queue = [];
    let anchor = anchorOverride ?? roots?.[0];
    if (!anchor && owned.length) anchor = owned.map(nodePoint).find(point =>
      travelClear(access, blockers, point, point, radius));
    if (anchor) for (const cell of owned) {
      if (Math.hypot(nodePoint(cell).x - anchor.x, nodePoint(cell).y - anchor.y) <= 2.5 * size
        && free(cell) && travelClear(access, blockers, anchor, nodePoint(cell), radius)) {
        reached.add(nodeKey(cell)); queue.push(cell);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head], point = nodePoint(cell);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const next = nodesByKey.get(`${cell.x + dx + 1},${cell.y + dy + 1}`);
        if (!next || reached.has(nodeKey(next)) || !free(next)) continue;
        if (!travelClear(access, blockers, point, nodePoint(next), radius)) continue;
        reached.add(nodeKey(next)); queue.push(next);
      }
    }
    const walkableNodes = owned.filter(free).map(nodeKey).sort();
    return { candidateNodes: owned.length, walkableNodes: walkableNodes.length,
      reachableNodes: reached.size, walkable: walkableNodes, reachable: [...reached].sort(),
      anchorPoint: anchor, anchor: anchor ? (roots ? 'first-portal' : 'first-walkable-node') : 'none' };
  }
  function lootReach(brief, blockers, reach, sites) {
    const access = createAccessMask(brief), radius = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' }).clearance.contestant;
    let checked = 0;
    const reachableSites = [];
    for (const site of sites) {
      checked++;
      if (reach.anchorPoint && findRegionRoute(access, blockers, reach.anchorPoint, { x: site.x, y: site.y }, radius))
        reachableSites.push(`${site.x},${site.y},${site.tier}`);
    }
    return { checked, reachableSites: reachableSites.length, unreachableSites: checked - reachableSites.length,
      reachableSiteKeys: reachableSites };
  }
  function inspect(brief, built, anchorOverride) {
    const blockers = built.elements.flatMap(e => elementShapes(e));
    const fill = measureFill(brief, built.elements);
    const errors = [...validateFillConstraints(brief, built.elements.flatMap(e => elementShapes(e, true))),
      ...validatePortalReach({ ...brief, blockers }).errors];
    const root = portalStands(brief)[0]?.points[0];
    let doorsChecked = 0;
    const unreachableDoors = [];
    if (root) for (const element of built.elements.filter(e => e.label.startsWith('checkpoint-post'))) {
      for (const gate of element.template.parts.filter(p => p.part === 'gate')) {
        const point = { x: element.x + gate.x, y: element.y + gate.y };
        if (!findRegionRoute(createAccessMask(brief), blockers, root, point, hunterClearance(brief.cellSize)))
          unreachableDoors.push(`${element.label}: no hunter route to door at ${point.x},${point.y}`);
        doorsChecked++;
      }
    }
    const freeReach = freeAreaReach(brief, blockers, anchorOverride);
    return { elements: built.elements.length, crates: built.manifest.infillCrates ?? 0,
      posts: built.manifest.posts ?? 0, barriers: built.manifest.barriers ?? 0,
      loot: built.loot.length, cells: fill.cells, freeCells: fill.freeCells, doorsChecked, unreachableDoors,
      freeArea: { candidateNodes: freeReach.candidateNodes, walkableNodes: freeReach.walkableNodes,
        reachableNodes: freeReach.reachableNodes, anchor: freeReach.anchor }, errors, _freeReach: freeReach };
  }
  function compare(brief) {
    const beforeTraces = [], afterTraces = [];
    const before = beforeBuild(brief, trace => beforeTraces.push(trace));
    const after = buildCheckpoint(brief, trace => afterTraces.push(trace));
    assert.deepEqual(after.elements.filter(e => !e.label.startsWith('checkpoint-infill-')), before.elements, `${brief.id}: primary elements`);
    assert.deepEqual(afterTraces, beforeTraces, `${brief.id}: building traces`);
    for (const crate of after.elements.filter(e => e.label.startsWith('checkpoint-infill-'))) {
      const a = { x: crate.x, y: crate.y, w: crate.template.w, h: crate.template.h };
      for (const other of after.elements) if (other !== crate) {
        const b = { x: other.x, y: other.y, w: other.template.w, h: other.template.h };
        assert.ok(Math.max(b.x - a.x - a.w, a.x - b.x - b.w,
          b.y - a.y - a.h, a.y - b.y - b.h) > 2 * brief.cellSize - 1e-7,
        `${brief.id}: ${crate.label} keeps two-cell spacing from ${other.label}`);
      }
    }
    const oldCheck = inspect(brief, before), newCheck = inspect(brief, after, oldCheck._freeReach.anchorPoint);
    assert.deepEqual(newCheck.unreachableDoors, oldCheck.unreachableDoors, `${brief.id}: post door access`);
    const newFreeReach = new Set(newCheck._freeReach.reachable);
    const newWalkable = new Set(newCheck._freeReach.walkable);
    const lostFreeNodes = oldCheck._freeReach.reachable.filter(node => newWalkable.has(node) && !newFreeReach.has(node));
    const newlyBlockedNodes = oldCheck._freeReach.reachable.filter(node => !newWalkable.has(node));
    const sampledLoot = spreadLoot(before.loot);
    const afterSites = new Set(after.loot.map(site => `${site.x},${site.y},${site.tier}`));
    const retainedLoot = sampledLoot.filter(site => afterSites.has(`${site.x},${site.y},${site.tier}`));
    const beforeLootReach = lootReach(brief, before.elements.flatMap(e => elementShapes(e)), oldCheck._freeReach, retainedLoot);
    const afterLootReach = lootReach(brief, after.elements.flatMap(e => elementShapes(e)), newCheck._freeReach, retainedLoot);
    const newLootReach = new Set(afterLootReach.reachableSiteKeys);
    const newlyUnreachableLoot = beforeLootReach.reachableSiteKeys.filter(site => !newLootReach.has(site));
    const removedSampledLoot = sampledLoot.length - retainedLoot.length;
    assert.equal(lostFreeNodes.length, 0, `${brief.id}: infill disconnects a still-walkable hunter standing node`);
    if (brief.id.startsWith('dumbbell-neck'))
      assert.ok(oldCheck._freeReach.reachable.some(node => Number(node.split(',')[0]) >= 20),
        `${brief.id}: baseline hunter flood reaches the far dumbbell room`);
    assert.equal(newlyUnreachableLoot.length, 0, `${brief.id}: infill makes retained loot sites unreachable`);
    delete beforeLootReach.reachableSiteKeys;
    delete afterLootReach.reachableSiteKeys;
    const { _freeReach: beforeGrid, ...beforeReport } = oldCheck;
    const { _freeReach: afterGrid, ...afterReport } = newCheck;
    return { id: brief.id, before: beforeReport, after: afterReport,
      freeArea: { beforeReachableNodes: beforeGrid.reachableNodes, afterReachableNodes: afterGrid.reachableNodes,
        lostStillWalkableNodes: lostFreeNodes.length, newlyBlockedNodes: newlyBlockedNodes.length,
        candidateNodes: beforeGrid.candidateNodes, walkableNodesBefore: beforeGrid.walkableNodes,
        walkableNodesAfter: afterGrid.walkableNodes, anchor: beforeGrid.anchor },
      retainedLootReach: { sampledBaselineSites: sampledLoot.length, retainedSampledSites: retainedLoot.length,
        removedSampledSites: removedSampledLoot, newlyUnreachableSites: newlyUnreachableLoot.length,
        before: beforeLootReach, after: afterLootReach,
        sampling: `Up to ${lootReachSampleLimit} spatially spread baseline sites; contestant-sized findRegionRoute checks from the shared baseline anchor.` } };
  }
  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(b => b.type === 'checkpoint').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length, crates: rows.reduce((n, r) => n + r.after.crates, 0),
      errors: [...views.report.defects, ...rows.flatMap(r => [...r.before.errors, ...r.after.errors])] }));
  }
  const cells = Array.from({ length: 24 * 18 }, (_, n) => ({ x: n % 24, y: Math.floor(n / 24) }));
  const direct = Array.from({ length: 10 }, (_, n) => compare({ id: `checkpoint-${n + 1}`, seed: n + 1, type: 'checkpoint', cellSize: 40,
    cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'east', axis: 'v', x: 24, y: 8, length: 2 }] }));
  const variants = [];
  for (const [name, cells, portals] of [
    ['ell', cellsOf(30, 30, (x, y) => y < 12 || x < 12), [
      { id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 }]],
    ['one', cellsOf(20, 16), [{ id: 'west', axis: 'v', x: 0, y: 6, length: 3 }]],
    ['none', cellsOf(20, 16), []],
    ['narrow', cellsOf(24, 3), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 0, length: 3 }]],
  ]) for (let seed = 1; seed <= 5; seed++) variants.push(compare({ id: `${name}-${seed}`, seed,
    type: 'checkpoint', cellSize: 40, cells, portals, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }] }));
  const dumbbells = [];
  for (const neckHeight of [2, 3]) {
    const cells = cellsOf(26, 12, (x, y) => x < 10 || x >= 16 || (x >= 10 && x < 16 && y >= 5 && y < 5 + neckHeight));
    for (const seed of [3, 25]) dumbbells.push(compare({ id: `dumbbell-neck${neckHeight}-${seed}`, seed,
      type: 'checkpoint', cellSize: 40, cells, portals: [{ id: 'west', axis: 'v', x: 0, y: 5, length: 2 }],
      zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }] }));
  }
  const sideLobeCells = cellsOf(26, 12, (x, y) =>
    (y >= 8 && y < 12) || (x >= 8 && x < 18 && y < 7) || (x >= 12 && x < 14 && y === 7));
  const sideLobePortals = [{ id: 'west', axis: 'v', x: 0, y: 9, length: 2 }, { id: 'east', axis: 'v', x: 26, y: 9, length: 2 }];
  const sideLobes = [3, 25].map(seed => compare({ id: `multiportal-side-lobe-${seed}`, seed,
    type: 'checkpoint', cellSize: 40, cells: sideLobeCells, portals: sideLobePortals,
    zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells: sideLobeCells }] }));
  const sourceHashes = Object.fromEntries(await Promise.all([sourcePath, 'tools/checkpoint-infill-audit.mjs',
    'map/micro/canvas.ts', 'map/micro/strategies/scatter.ts', 'map/micro/strategies/infill.ts', 'map/micro/placeables/cover-piece.ts', 'map/micro/region-types.ts']
    .map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'checkpoint-side-yard-infill-1', baselineCommit, commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', sourcePath, 'map/micro/region-types.ts'),
    createdAt: new Date().toISOString(), node: process.version, contentVersion: REGION_TYPES_VERSION, sourceHashes,
    maps, direct, variants, dumbbells, sideLobes, limits: 'One current-library map per authored size, ten direct 24x18 cases, twenty concave/one-portal/portalless/narrow cases, four single-portal dumbbells with 2/3-cell necks at seeds 3/25, and two multiportal side-lobe cases. Historical checkpoint module with current shared dependencies. Exact primary elements/traces, two-cell spacing, fill/margins, portal promises and unchanged post-door reachability are checked. Independent reach audit floods integer cell-intersection hunter stands with swept-clearance cardinal edges; it reports candidate, walkable and reachable nodes, and fails if a previously reachable node remains walkable but becomes disconnected. Newly blocked nodes are reported separately. Up to 20 spatially spread baseline loot sites per case are checked with contestant-sized findRegionRoute from the shared baseline anchor; only newly unreachable retained sites fail. This is bounded sampled geometry, not a proof of continuous-space reachability; removed sampled loot and pre-existing inaccessible targets are reported separately. No delegation acceptance rate, human balance or exhaustive coverage claimed.' };
  const out = resolve(args.get('out') ?? 'test-results/575/checkpoint.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  if (maps.some(m => m.mapErrors.length || m.rows.some(r => r.before.errors.length || r.after.errors.length))
    || [...direct, ...variants, ...dumbbells, ...sideLobes].some(r => r.before.errors.length || r.after.errors.length)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
