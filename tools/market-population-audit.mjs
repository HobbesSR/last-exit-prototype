// #534: compare market population with the pinned hall stand-in on the same briefs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../map/chain.ts';
import { GAME_ENGINES } from '../map/engines.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildMarket } from '../map/micro/strategies/market.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { bounds, rect } from '../shared/shape.ts';
import { createAccessMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { chainBrief } from '../tests/helpers/chain-briefs.js';
import { cellsOf } from '../tests/helpers/cells.js';
import { options } from './options.mjs';

const args = options(process.argv.slice(2), ['out', 'baseline-ref'], arg => `Unknown option ${arg}`);
const baselineRef = args.get('baseline-ref') ?? '912e8c6';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`);
const baselinePath = 'map/micro/strategies/hall.ts';
const oldSource = execFileSync('git', ['show', `${baselineCommit}:${baselinePath}`], { encoding: 'utf8' });
const scratchRoot = resolve('test-results');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'market-population-audit-'));
const baselineFile = resolve(scratch, 'baseline.ts');
await writeFile(baselineFile, oldSource.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
  (_, start, relative, end) => `${start}${pathToFileURL(resolve(dirname(baselinePath), relative)).href}${end}`));

try {
  const beforeBuild = (await import(pathToFileURL(baselineFile).href)).buildHall;
  const limit = 4;
  const sample = list => list.length <= limit ? list : Array.from({ length: limit }, (_, i) => list[Math.floor(i * (list.length - 1) / (limit - 1))]);
  const key = site => `${site.x},${site.y},${site.tier}`;
  // The same shapesOverlap test as measureFill, but only visit cells within each
  // obstacle's bounding box; no greedy largest-free-rectangle search is needed.
  function occupancy(input, blockers) {
    const size = input.cellSize, owned = new Set(input.cells.map(c => `${c.x},${c.y}`)), occupied = new Set();
    for (const shape of blockers) {
      const box = bounds(shape);
      for (let y = Math.floor(box.y / size); y <= Math.floor((box.y + box.h) / size); y++)
        for (let x = Math.floor(box.x / size); x <= Math.floor((box.x + box.w) / size); x++) {
          const id = `${x},${y}`;
          if (owned.has(id) && !occupied.has(id) && shapesOverlap(shape, rect(x * size, y * size, size, size))) occupied.add(id);
        }
    }
    return { cells: input.cells.length, occupiedCells: occupied.size, freeCells: owned.size - occupied.size };
  }
  function inspect(input, built) {
    const blockers = built.elements.flatMap(element => elementShapes(element));
    const fill = occupancy(input, blockers);
    const gates = built.elements.reduce((n, element) => n + element.template.parts.filter(p => p.part === 'gate').length, 0);
    const roofCells = built.elements.reduce((n, element) => n + (element.template.roofs ?? []).reduce((m, roof) => m + roof.cells.length, 0), 0);
    // Sum of primitive areas, not a union; overlapping shapes are counted twice.
    const physicalArea = blockers.reduce((n, shape) => n + (shape.kind === 'rect' ? shape.w * shape.h
      : shape.kind === 'circle' ? Math.PI * shape.r ** 2 : Math.abs(shape.points.reduce((sum, p, i, points) => {
        const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y;
      }, 0)) / 2), 0);
    return { elements: built.elements.length, stalls: built.manifest.stalls ?? 0, awnings: built.manifest.awnings ?? 0,
      gates, loot: built.loot.length, cells: fill.cells, occupiedCells: fill.occupiedCells,
      freeCells: fill.freeCells, physicalArea, roofCells,
      enclosedElements: built.elements.filter(element => element.template.encloses).length,
      legacyEnclosedRoofCellsEstimate: built.elements.filter(element => element.template.encloses && !element.template.roofs?.length)
        .reduce((n, element) => n + element.template.w * element.template.h / input.cellSize ** 2, 0),
      errors: { fill: validateFillConstraints(input, built.elements.flatMap(element => elementShapes(element, true))),
        portal: validatePortalReach({ ...input, blockers }).errors } };
  }
  function reach(input, blockers, root, points, radius) {
    const mask = createAccessMask(input);
    return points.map(point => !!root && !!findRegionRoute(mask, blockers, root, point, radius));
  }
  function compare(input) {
    const before = beforeBuild(input), after = buildMarket(input);
    const oldCheck = inspect(input, before), newCheck = inspect(input, after);
    const oldBlockers = before.elements.flatMap(e => elementShapes(e)), newBlockers = after.elements.flatMap(e => elementShapes(e));
    const root = portalStands(input)[0]?.points[0];
    const retained = new Set(after.loot.map(key));
    const sites = sample(before.loot).filter(site => retained.has(key(site)));
    const contestant = microMetrics({ cellSize: input.cellSize, bodyProfile: 'cell' }).clearance.contestant;
    const oldLoot = reach(input, oldBlockers, root, sites, contestant), newLoot = reach(input, newBlockers, root, sites, contestant);
    // Probe both long edges and both ends of each sampled new stall at one cell from its footprint.
    // The same points are checked against the old hall, so already-inaccessible points remain visible.
    const stalls = sample(after.elements.filter(e => e.label.startsWith('market-stall-')));
    const probes = stalls.flatMap(e => {
      const { w, h } = e.template, d = input.cellSize;
      return [{ x: e.x + w / 2, y: e.y - d }, { x: e.x + w / 2, y: e.y + h + d },
        { x: e.x - d, y: e.y + h / 2 }, { x: e.x + w + d, y: e.y + h / 2 }];
    });
    const oldHunter = reach(input, oldBlockers, root, probes, hunterClearance(input.cellSize));
    const newHunter = reach(input, newBlockers, root, probes, hunterClearance(input.cellSize));
    const newErrors = Object.fromEntries(Object.keys(oldCheck.errors).map(kind => [kind,
      newCheck.errors[kind].filter(error => !oldCheck.errors[kind].includes(error))]));
    return { id: input.id, before: oldCheck, after: newCheck, newErrors,
      retainedLootReach: { sampledBaseline: Math.min(limit, before.loot.length), retained: sites.length,
        beforeUnreachable: oldLoot.filter(v => !v).length, afterUnreachable: newLoot.filter(v => !v).length,
        newlyUnreachable: oldLoot.filter((v, i) => v && !newLoot[i]).length },
      stallProbes: { sampledStalls: stalls.length, points: probes.length, beforeUnreachable: oldHunter.filter(v => !v).length,
        afterUnreachable: newHunter.filter(v => !v).length, newlyUnreachable: oldHunter.filter((v, i) => v && !newHunter[i]).length,
        failures: probes.filter((_, i) => oldHunter[i] && !newHunter[i]) } };
  }
  const maps = [];
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [36, 18]]) {
    const seed = `issue330-before-${zoneWidth}x${zoneHeight}`;
    const views = mapViews(generate(seed, { mode: 'game', zoneWidth, zoneHeight }), GAME_ENGINES.compose);
    const rows = views.briefs.filter(input => input.type === 'market').map(compare);
    maps.push({ seed, zoneWidth, zoneHeight, rows, mapErrors: views.report.defects });
    console.log(JSON.stringify({ seed, regions: rows.length, stalls: rows.reduce((n, row) => n + row.after.stalls, 0) }));
  }
  const fixtures = [
    ['rectangle', 24, 18, () => true, 9],
    ['L', 24, 24, (x, y) => x < 12 || y < 12, 4],
    ['holed', 24, 24, (x, y) => x < 8 || x >= 16 || y < 8 || y >= 16, 4],
    ['nofit', 5, 18, () => true, 8],
  ];
  const direct = fixtures.map(([name, w, h, include, portalY]) => compare(chainBrief({ id: `market-${name}`, seed: 17,
    type: 'market', cells: cellsOf(w, h, include), portals: [
      { id: 'west', axis: 'v', x: 0, y: portalY, length: 2 },
      { id: 'east', axis: 'v', x: w, y: portalY, length: 2 },
    ] })));
  const paths = ['tools/market-population-audit.mjs', 'map/micro/strategies/market.ts', baselinePath,
    'map/micro/placeables/market-stall.ts', 'map/micro/geometry.ts', 'map/micro/portals.ts', 'map/micro/region-types.ts', 'tests/helpers/chain-briefs.js'];
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report = { audit: 'market-population-1', baselineRef, baselineCommit, commit: git('rev-parse', 'HEAD'),
    baselineSourceHash: createHash('sha256').update(oldSource).digest('hex'), sourceHashes,
    dirty: git('status', '--porcelain'), createdAt: new Date().toISOString(), node: process.version,
    contentVersion: REGION_TYPES_VERSION, maps, direct,
    limits: 'Only the historical hall strategy is pinned; both builds use current dependencies and exactly the same current market briefs. Three authored maps and four chain-like direct shapes are bounded samples. Roof cells count explicit roof cells only; legacy enclosing buildings and their rectangular footprint in cell units are estimated separately. Physical area is a sum of primitive areas, not a union. At most four retained baseline loot sites use contestant routes; up to four new stalls have four sampled hunter targets one cell beyond their footprint, checked in both builds. Missing first portal yields unreachable targets. Portal and route search is sampled and a miss does not prove no route exists. New errors and access losses are compared with the baseline; pre-existing failures and map defects are recorded. No exhaustive reachability or balance claim.' };
  const out = resolve(args.get('out') ?? 'test-results/534/market.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const rows = [...maps.flatMap(map => map.rows), ...direct];
  if (!maps.some(map => map.rows.some(row => row.after.stalls > 0)) || rows.some(row => row.after.gates ||
    Object.values(row.newErrors).some(errors => errors.length) || row.retainedLootReach.newlyUnreachable || row.stallProbes.newlyUnreachable)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
