// Measure #422, the free-space mesh as navigation's bottom level (22.6 stage 2), against the
// 40-unit grid it replaces, on the same maps: node --expose-gc tools/navigation/mesh-report.mjs [output.json]
// Runs sequentially under the bench lock. Production bots are untouched; this reads generation only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { generate } from '../../map/chain.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../../map/micro/adapter.ts';
import { liveChainParams, LIVE_ZONE_SIZES, zoneSizeName } from '../../map/live.ts';
import { DEFAULT_CELL_SIZE } from '../../map/engines.ts';
import { buildPortalGraph } from '../../map/navigation.ts';
import { createPortalPlanner, regionTables, standJoins } from '../../shared/navigation/portal-graph.ts';
import { meshReach, regionMeshes } from '../../shared/navigation/mesh-level.ts';
import { gridReach, stepsLength } from '../../shared/navigation/grid-level.ts';
import { gridRoute } from '../../shared/map/route.ts';
import { TILE } from '../../shared/movement.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const SEEDS = { '12x6': 20, '24x12': 5, '36x18': 3 };
const ROLES = ['contestant', 'gladiator'];
const SOURCES = ['map/navigation.ts', 'shared/navigation/portal-graph.ts', 'shared/navigation/mesh-level.ts', 'shared/navigation/grid-level.ts',
  'shared/free-space.ts', 'shared/index-heap.ts', 'shared/movement.ts', 'shared/map/navigation.ts', 'tools/navigation/mesh-report.mjs'];
const time = fn => { const start = performance.now(); const value = fn(); return { ms: performance.now() - start, value }; };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const gc = () => globalThis.gc?.();
const bytesOf = space => space.points.byteLength + space.triangles.byteLength + space.twins.byteLength + space.locator.starts.byteLength + space.locator.items.byteLength;

/** Each promised pair a table leaves unreached, and the length ratios between two tables where both reach. */
function compareTables(graph, built, mesh, grid) {
  const unreached = { mesh: [], grid: [] }, ratios = [];
  graph.regions.forEach((region, index) => {
    const k = region.portals.length;
    if (k < 2) return;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
      const m = mesh[index][i * k + j], g = grid[index][i * k + j];
      const pair = { region: region.id, type: built.regions[index].brief.type, a: graph.portals[region.portals[i]].id, b: graph.portals[region.portals[j]].id };
      if (m === Infinity) unreached.mesh.push(pair);
      if (g === Infinity) unreached.grid.push(pair);
      if (m !== Infinity && g !== Infinity && g > 0) ratios.push(m / g);
    }
  });
  ratios.sort((a, b) => a - b);
  return { meshUnreached: unreached.mesh.length, gridUnreached: unreached.grid.length, meshOnly: unreached.grid.length - unreached.mesh.length,
    unreached: { mesh: unreached.mesh.slice(0, 20), grid: unreached.grid.slice(0, 20) },
    tableRatio: ratios.length ? { median: median(ratios), min: ratios[0], max: ratios.at(-1), p95: ratios[Math.floor(ratios.length * 0.95)] } : null };
}

function measureMap(size, seed) {
  const generated = time(() => composeRegions(generate(seed, liveChainParams(undefined, size), undefined, DEFAULT_CELL_SIZE).results));
  const built = generated.value, collision = builtMapCollision(built), { origin } = builtMapFrame(built);
  const graphed = time(() => buildPortalGraph(built, origin)), graph = graphed.value;
  const world = site => ({ x: site.x + origin.x, y: site.y + origin.y });
  const sites = built.regions.flatMap(r => r.coreElements.map(s => ({ kind: s.kind, ...world(s) })));
  const spawns = sites.filter(s => s.kind === 'spawn'), hunters = sites.filter(s => s.kind === 'hunter-spawn'), exit = sites.find(s => s.kind === 'exit');
  const pairs = { 'spawn-exit': [spawns[0], exit], 'first-last-spawn': [spawns[0], spawns.at(-1)], 'hunter-exit': [hunters[0], exit] };
  const full = { x: 0, y: 0, width: Math.ceil(collision.width / TILE), height: Math.ceil(collision.height / TILE) };
  const result = { size: zoneSizeName(size), seed, generationMs: generated.ms, graphMs: graphed.ms, regions: graph.regions.length, portals: graph.portals.length,
    obstacles: collision.obstacles.length, gates: collision.gates.length,
    promisedPairs: graph.regions.filter(r => r.portals.length >= 2).reduce((n, r) => n + r.portals.length * (r.portals.length - 1) / 2, 0), roles: {} };
  for (const role of ROLES) {
    const doors = {};
    let planner;
    for (const openDoors of [false, true]) {
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const meshes = time(() => regionMeshes(collision, role, graph, openDoors));
      gc();
      const heapAfter = process.memoryUsage().heapUsed;
      const reach = meshReach(collision, role, graph, openDoors);
      const tabled = time(() => regionTables(graph, reach));
      const joined = time(() => standJoins(graph, reach));
      const grid = gridReach(collision, role, graph, openDoors);
      const gridTabled = time(() => regionTables(graph, grid));
      const gridJoined = time(() => standJoins(graph, grid));
      doors[openDoors ? 'openable' : 'closed'] = {
        meshBuildMs: meshes.ms, triangles: meshes.value.reduce((n, s) => n + s.triangles.length / 3, 0),
        meshBytes: meshes.value.reduce((n, s) => n + bytesOf(s), 0), heapDeltaBytes: heapAfter - heapBefore,
        tablesMs: tabled.ms, standsMs: joined.ms, dividedPortals: joined.value.length, divided: joined.value.slice(0, 20),
        defects: reach.defects.length, defectSamples: reach.defects.slice(0, 10),
        gridTablesMs: gridTabled.ms, gridStandsMs: gridJoined.ms, gridDividedPortals: gridJoined.value.length,
        ...compareTables(graph, built, tabled.value, gridTabled.value) };
      if (openDoors) planner = { mesh: createPortalPlanner(graph, reach, tabled.value), grid: createPortalPlanner(graph, grid, gridTabled.value) };
    }
    const routes = {};
    for (const [name, [from, to]] of Object.entries(pairs)) {
      const trials = [0, 1, 2].map(() => time(() => planner.mesh.route(from, to)));
      const route = trials[0].value, gridRouted = planner.grid.route(from, to);
      const fine = time(() => gridRoute(collision, role, full, from, to, true));
      const reference = fine.value ? stepsLength(from, fine.value, to) : null;
      routes[name] = { status: route.status, length: Number.isFinite(route.length) ? route.length : null, waypoints: route.waypoints.length,
        meshMs: trials.map(t => t.ms), meshMedianMs: median(trials.map(t => t.ms)),
        gridLevelStatus: gridRouted.status, gridLevelLength: Number.isFinite(gridRouted.length) ? gridRouted.length : null,
        fineMs: fine.ms, fineLength: reference, stretch: reference && Number.isFinite(route.length) ? route.length / reference : null,
        distance: Math.hypot(to.x - from.x, to.y - from.y) };
    }
    result.roles[role] = { doors, routes };
  }
  return result;
}

const lock = await acquireMachineLock('bench');
try {
  const out = process.argv[2] ?? 'test-results/navigation-422.json';
  const report = { revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), created: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cpuCount: os.cpus().length, totalMemory: os.totalmem(),
    exposeGc: typeof globalThis.gc === 'function',
    sourceHashes: Object.fromEntries(SOURCES.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), maps: [] };
  for (const size of LIVE_ZONE_SIZES) for (let seed = 1; seed <= SEEDS[zoneSizeName(size)]; seed++) {
    console.error(`Measuring ${zoneSizeName(size)} seed ${seed}`);
    report.maps.push(measureMap(size, seed));
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
} finally { lock.release(); }
