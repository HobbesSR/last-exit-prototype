// #577: compare plant residual infill on identical current-library briefs against a pinned strategy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildPlant } from '../map/micro/strategies/plant.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { measureFill } from '../map/micro/fill.ts';
import { createAccessMask, elementShapes, findRegionRoute, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { rect } from '../shared/shape.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? 'df815bb';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const sourcePath = 'map/micro/strategies/plant.ts';
const oldSource = git('show', `${baselineCommit}:${sourcePath}`);
// Pin only the strategy; current geometry, placeables and authored library stay shared.
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'plant-infill-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(sourcePath), relative)).href}${end}`));

const cellSize = 40;
const cellsOf = (w, h, include = () => true) => Array.from({ length: w * h }, (_, n) => ({ x: n % w, y: Math.floor(n / w) }))
  .filter(cell => include(cell.x, cell.y));
const brief = (id, seed, w, h, include, portals, parameters = { density: 0.6, shed: 0.5 }) => {
  const cells = cellsOf(w, h, include);
  return { id, seed, type: 'plant', cellSize, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals, parameters };
};
const rectPortals = (w, h) => [
  { id: 'west', axis: 'v', x: 0, y: Math.floor(h / 2) - 1, length: 2 },
  { id: 'east', axis: 'v', x: w, y: Math.floor(h / 2) - 1, length: 2 },
];

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildPlant;
  const lootReachSampleLimit = 20;
  function spreadLoot(sites) {
    if (!sites.length) return [];
    const selected = [sites[0]], remaining = new Set(sites.slice(1));
    while (selected.length < lootReachSampleLimit && remaining.size) {
      let best, bestDistance = -1;
      for (const site of remaining) {
        const distance = Math.min(...selected.map(chosen => (site.x - chosen.x) ** 2 + (site.y - chosen.y) ** 2));
        if (distance > bestDistance) { best = site; bestDistance = distance; }
      }
      selected.push(best); remaining.delete(best);
    }
    return selected;
  }
  // Independent bounded flood over integer cell intersections where a hunter can stand.
  function freeAreaReach(input, blockers, anchorOverride) {
    const access = createAccessMask(input), size = input.cellSize, radius = hunterClearance(size);
    const owned = [...input.cells].sort((a, b) => a.y - b.y || a.x - b.x);
    const roots = portalStands(input)[0]?.points;
    const point = cell => ({ x: (cell.x + 1) * size, y: (cell.y + 1) * size });
    const id = cell => `${cell.x + 1},${cell.y + 1}`;
    const byId = new Map(owned.map(cell => [id(cell), cell])), walkable = new Map();
    const free = cell => {
      if (!walkable.has(id(cell))) walkable.set(id(cell), travelClear(access, blockers, point(cell), point(cell), radius));
      return walkable.get(id(cell));
    };
    let anchor = anchorOverride ?? roots?.[0];
    if (!anchor && owned.length) anchor = owned.map(point).find(at => travelClear(access, blockers, at, at, radius));
    const reached = new Set(), queue = [];
    if (anchor) for (const cell of owned) if (Math.hypot(point(cell).x - anchor.x, point(cell).y - anchor.y) <= 2.5 * size
      && free(cell) && travelClear(access, blockers, anchor, point(cell), radius)) {
      reached.add(id(cell)); queue.push(cell);
    }
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head], at = point(cell);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const next = byId.get(`${cell.x + dx + 1},${cell.y + dy + 1}`);
        if (!next || reached.has(id(next)) || !free(next) || !travelClear(access, blockers, at, point(next), radius)) continue;
        reached.add(id(next)); queue.push(next);
      }
    }
    const walkableNodes = owned.filter(free).map(id).sort();
    return { candidateNodes: owned.length, walkableNodes: walkableNodes.length, reachableNodes: reached.size,
      walkable: walkableNodes, reachable: [...reached].sort(), anchorPoint: anchor,
      anchor: anchor ? roots ? 'first-portal' : 'first-walkable-node' : 'none' };
  }
  function lootReach(input, blockers, reach, sites) {
    const access = createAccessMask(input), radius = microMetrics({ cellSize: input.cellSize, bodyProfile: 'cell' }).clearance.contestant;
    const reachable = [];
    for (const site of sites) if (reach.anchorPoint
      && findRegionRoute(access, blockers, reach.anchorPoint, { x: site.x, y: site.y }, radius))
      reachable.push(`${site.x},${site.y},${site.tier}`);
    return { checked: sites.length, reachableSites: reachable.length, unreachableSites: sites.length - reachable.length,
      reachableSiteKeys: reachable };
  }
  function inspect(input, built, anchorOverride) {
    const blockers = built.elements.flatMap(element => elementShapes(element));
    const access = createAccessMask(input);
    const fill = measureFill(input, built.elements);
    const errors = {
      fill: validateFillConstraints(input, built.elements.flatMap(element => elementShapes(element, true))),
      portal: validatePortalReach({ ...input, blockers }).errors,
    };
    const root = portalStands(input)[0]?.points[0];
    const unreachableDoors = [];
    let doorsChecked = 0;
    if (root) for (const element of built.elements.filter(e => e.label.startsWith('plant-shed-'))) {
      for (const gate of element.template.parts.filter(part => part.part === 'gate')) {
        const point = { x: element.x + gate.x, y: element.y + gate.y };
        const target = `${element.label}: ${point.x},${point.y}`;
        if (!findRegionRoute(createAccessMask(input), blockers, root, point, hunterClearance(input.cellSize))) unreachableDoors.push(target);
        doorsChecked++;
      }
    }
    const byPrefix = prefix => built.elements.filter(element => element.label.startsWith(prefix)).length;
    const infill = built.elements.filter(element => element.label.startsWith('plant-infill-'));
    for (const crate of infill) {
      const x = crate.x / input.cellSize, y = crate.y / input.cellSize;
      assert.ok(access.contains(rect((x - 2) * input.cellSize, (y - 2) * input.cellSize,
        crate.template.w + 4 * input.cellSize,
        crate.template.h + 4 * input.cellSize)), `${input.id}: ${crate.label} has a full two-cell access ring`);
    }
    const freeReach = freeAreaReach(input, blockers, anchorOverride);
    return { elements: built.elements.length, infillCrates: built.manifest.infillCrates ?? 0,
      machines: built.manifest.machines ?? byPrefix('plant-machine-'), pipes: built.manifest.pipes ?? byPrefix('plant-pipe-'),
      sheds: built.manifest.sheds ?? byPrefix('plant-shed-'), loot: built.loot.length,
      cells: fill.cells, freeCells: fill.freeCells, doorsChecked, unreachableDoors, errors,
      freeArea: { candidateNodes: freeReach.candidateNodes, walkableNodes: freeReach.walkableNodes,
        reachableNodes: freeReach.reachableNodes, anchor: freeReach.anchor }, _freeReach: freeReach };
  }
  function compare(input) {
    const beforeTraces = [], afterTraces = [];
    const before = beforeBuild(input, trace => beforeTraces.push(trace));
    const after = buildPlant(input, trace => afterTraces.push(trace));
    assert.deepEqual(after.elements.filter(element => !element.label.startsWith('plant-infill-')), before.elements,
      `${input.id}: primary elements`);
    assert.deepEqual(afterTraces, beforeTraces, `${input.id}: building traces`);
    const oldCheck = inspect(input, before), newCheck = inspect(input, after, oldCheck._freeReach.anchorPoint);
    const newlyUnreachableDoors = newCheck.unreachableDoors.filter(target => !oldCheck.unreachableDoors.includes(target));
    const recoveredDoors = oldCheck.unreachableDoors.filter(target => !newCheck.unreachableDoors.includes(target));
    const newErrors = Object.fromEntries(Object.keys(oldCheck.errors).map(kind => [kind,
      newCheck.errors[kind].filter(error => !oldCheck.errors[kind].includes(error))]));
    const afterWalkable = new Set(newCheck._freeReach.walkable), afterReachable = new Set(newCheck._freeReach.reachable);
    const lostNodes = oldCheck._freeReach.reachable.filter(node => afterWalkable.has(node) && !afterReachable.has(node));
    const newlyBlockedNodes = oldCheck._freeReach.reachable.filter(node => !afterWalkable.has(node));
    assert.equal(lostNodes.length, 0, `${input.id}: infill disconnects a still-walkable hunter node`);
    const sampledLoot = spreadLoot(before.loot), afterSites = new Set(after.loot.map(site => `${site.x},${site.y},${site.tier}`));
    const retainedLoot = sampledLoot.filter(site => afterSites.has(`${site.x},${site.y},${site.tier}`));
    const beforeLootReach = lootReach(input, before.elements.flatMap(element => elementShapes(element)), oldCheck._freeReach, retainedLoot);
    const afterLootReach = lootReach(input, after.elements.flatMap(element => elementShapes(element)), newCheck._freeReach, retainedLoot);
    const afterLootReachKeys = new Set(afterLootReach.reachableSiteKeys);
    const newlyUnreachableLoot = beforeLootReach.reachableSiteKeys.filter(site => !afterLootReachKeys.has(site));
    assert.equal(newlyUnreachableLoot.length, 0, `${input.id}: infill makes retained loot unreachable`);
    // Seed 3 supplies a positive far-lobe witness in all four configurations.
    // Seed 25's one-portal primary layout already blocks the neck; keep it as
    // a pre-existing limitation rather than changing the primary solve.
    if (input.id.startsWith('plant-dumbbell') && input.seed === 3)
      assert.ok(oldCheck._freeReach.reachable.some(node => Number(node.split(',')[0]) >= 20),
        `${input.id}: baseline hunter flood reaches far dumbbell lobe`);
    delete beforeLootReach.reachableSiteKeys; delete afterLootReach.reachableSiteKeys;
    const { _freeReach: beforeGrid, ...beforeReport } = oldCheck;
    const { _freeReach: afterGrid, ...afterReport } = newCheck;
    return { id: input.id, before: beforeReport, after: afterReport, newlyUnreachableDoors, recoveredDoors, newErrors,
      freeArea: { beforeReachableNodes: beforeGrid.reachableNodes, afterReachableNodes: afterGrid.reachableNodes,
        lostStillWalkableNodes: lostNodes.length, newlyBlockedNodes: newlyBlockedNodes.length,
        candidateNodes: beforeGrid.candidateNodes, walkableNodesBefore: beforeGrid.walkableNodes,
        walkableNodesAfter: afterGrid.walkableNodes, anchor: beforeGrid.anchor,
        ...input.id.startsWith('plant-dumbbell') ? {
          baselineFarLobeReachable: beforeGrid.reachable.some(node => Number(node.split(',')[0]) >= 20),
        } : {} },
      retainedLootReach: { sampledBaselineSites: sampledLoot.length, retainedSampledSites: retainedLoot.length,
        removedSampledSites: sampledLoot.length - retainedLoot.length, newlyUnreachableSites: newlyUnreachableLoot.length,
        before: beforeLootReach, after: afterLootReach,
        sampling: `Up to ${lootReachSampleLimit} spatially spread baseline sites; contestant-sized findRegionRoute checks from the shared baseline anchor.` } };
  }

  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(input => input.type === 'plant').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length,
      crates: rows.reduce((n, row) => n + row.after.infillCrates, 0),
      newErrors: rows.flatMap(row => Object.values(row.newErrors).flat()).length }));
  }

  const direct = [];
  for (let seed = 1; seed <= 10; seed++) direct.push(compare(brief(`plant-rect-${seed}`, seed, 24, 18,
    () => true, rectPortals(24, 18))));
  const varied = [
    ['L', 30, 30, (x, y) => y < 15 || x < 15],
    ['ring', 36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23],
    ['notched', 32, 24, (x, y) => !(x >= 12 && x < 20 && y >= 8 && y < 24)],
    ['thin', 10, 24, () => true],
  ];
  for (const [name, w, h, include] of varied) for (const seed of [17, 29, 43]) {
    const portals = rectPortals(w, h);
    // The east edge of the L ends at y=15; the rectangle's midline portal
    // would straddle that corner rather than belong to this region.
    if (name === 'L') portals[1].y = 5;
    direct.push(compare(brief(`plant-${name}-${seed}`, seed, w, h, include, portals)));
  }
  direct.push(compare(brief('plant-density-zero', 83, 24, 18, () => true, rectPortals(24, 18), { density: 0, shed: 0 })));

  const dumbbells = [];
  for (const neckHeight of [2, 3]) {
    const west = [{ id: 'west', axis: 'v', x: 0, y: 9, length: 2 }];
    const leftLobe = [...west, { id: 'north-left', axis: 'h', x: 4, y: 0, length: 2 }];
    for (const seed of [3, 25]) {
      dumbbells.push(compare(brief(`plant-dumbbell-neck${neckHeight}-${seed}`, seed, 30, 20,
        (x, y) => x < 10 || x >= 20 || (x >= 10 && x < 20 && y >= 9 && y < 9 + neckHeight), west)));
      dumbbells.push(compare(brief(`plant-dumbbell-left-portals-neck${neckHeight}-${seed}`, seed, 30, 20,
        (x, y) => x < 10 || x >= 20 || (x >= 10 && x < 20 && y >= 9 && y < 9 + neckHeight), leftLobe)));
    }
  }

  // Exercise the established >32-portal bounded boundary policy without a large world.
  const many = [];
  for (let x = 1; x < 70; x += 2) many.push({ id: `north-${x}`, axis: 'h', x, y: 0, length: 2 });
  many.push({ id: 'south', axis: 'h', x: 34, y: 24, length: 2 });
  direct.push(compare(brief('plant-many-portals', 71, 72, 24, () => true, many)));

  const sourcePaths = [sourcePath, 'tools/plant-infill-audit.mjs', 'map/micro/canvas.ts',
    'map/micro/strategies/scatter.ts', 'map/micro/strategies/infill.ts', 'map/micro/placeables/cover-piece.ts', 'map/micro/region-types.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'plant-residual-infill-1', baselineRef, baselineCommit, commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', sourcePath, 'map/micro/region-types.ts'),
    createdAt: new Date().toISOString(), node: process.version, contentVersion: REGION_TYPES_VERSION,
    sourceHashes, maps, direct, dumbbells,
    limits: 'Baseline strategy is pinned while shared current library, geometry and placeables are used on both sides. Three current-library authored maps, ten direct 24x18 cases, twelve varied-shape cases, a >32-portal case and eight dumbbell variants with 10x20 lobes, 2/3-cell necks and one or two portals on the left lobe. Checks exact primary geometry and building traces, full crate access rings, fill constraints, portal reach, shed-door reachability, and independent integer-intersection hunter reach with swept-clearance cardinal edges. A previously reachable node fails only if it remains walkable but becomes disconnected; newly blocked nodes are reported separately. Up to 20 spatially spread retained baseline loot sites use contestant-sized findRegionRoute checks from a shared baseline anchor and fail only on new losses. This bounded sample is not a proof of continuous-space reachability; removed sampled loot and pre-existing errors/door failures are reported separately. No claim of human balance, exhaustive coverage or performance beyond these samples.' };
  const out = resolve(args.get('out') ?? 'test-results/577/plant.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const rows = [...maps.flatMap(map => map.rows), ...direct, ...dumbbells];
  const newIssues = rows.flatMap(row => [...Object.values(row.newErrors).flat(), ...row.newlyUnreachableDoors]);
  if (newIssues.length || maps.some(map => map.mapErrors.length)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
