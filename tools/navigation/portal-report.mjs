// Measure #420, the portal graph (22.6 stage 1): node tools/navigation/portal-report.mjs [output.json]
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
import { gridReach, stepsLength } from '../../shared/navigation/grid-level.ts';
import { gridRoute } from '../../shared/map/route.ts';
import { TILE } from '../../shared/movement.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const SEEDS = { '12x6': 20, '24x12': 5, '36x18': 3 };
const ROLES = ['contestant', 'gladiator'];
const SOURCES = ['map/navigation.ts', 'shared/navigation/portal-graph.ts', 'shared/navigation/grid-level.ts', 'shared/movement.ts', 'shared/map/navigation.ts', 'tools/navigation/portal-report.mjs'];
const time = fn => { const start = performance.now(); const value = fn(); return { ms: performance.now() - start, value }; };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Today's planner: one grid search over the box spanning both ends plus 600 units (`bots.ts`). */
function windowed(map, role, from, to) {
  const x = Math.max(0, Math.floor((Math.min(from.x, to.x) - 600) / TILE)), y = Math.max(0, Math.floor((Math.min(from.y, to.y) - 600) / TILE));
  const width = Math.min(Math.ceil((Math.max(from.x, to.x) + 600) / TILE), Math.ceil(map.width / TILE)) - x;
  const height = Math.min(Math.ceil((Math.max(from.y, to.y) + 600) / TILE), Math.ceil(map.height / TILE)) - y;
  return gridRoute(map, role, { x, y, width, height }, from, to, true);
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
  const pairCount = graph.regions.reduce((n, r) => n + r.portals.length * (r.portals.length - 1) / 2, 0);
  const result = { size: zoneSizeName(size), seed, generationMs: generated.ms, graphMs: graphed.ms, regions: graph.regions.length, portals: graph.portals.length,
    promisedPairs: graph.regions.filter(r => r.portals.length >= 2).reduce((n, r) => n + r.portals.length * (r.portals.length - 1) / 2, 0),
    tableBytes: pairCount * 2 * 8, roles: {} };
  for (const role of ROLES) {
    const doors = {};
    let planner;
    for (const openDoors of [false, true]) {
      const reach = gridReach(collision, role, graph, openDoors);
      const tabled = time(() => regionTables(graph, reach));
      const broken = [];
      graph.regions.forEach((region, index) => {
        const k = region.portals.length, table = tabled.value[index];
        if (k < 2) return;
        for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (table[i * k + j] === Infinity)
          broken.push({ region: region.id, type: built.regions[index].brief.type, a: graph.portals[region.portals[i]].id, b: graph.portals[region.portals[j]].id });
      });
      const joined = time(() => standJoins(graph, reach));
      doors[openDoors ? 'openable' : 'closed'] = { tablesMs: tabled.ms, brokenPairs: broken.length, broken: broken.slice(0, 20),
        standsMs: joined.ms, dividedPortals: joined.value.length, divided: joined.value.slice(0, 20) };
      if (openDoors) planner = createPortalPlanner(graph, reach, tabled.value);
    }
    const routes = {};
    for (const [name, [from, to]] of Object.entries(pairs)) {
      const trials = [0, 1, 2].map(() => time(() => planner.route(from, to)));
      const route = trials[0].value;
      const fine = time(() => gridRoute(collision, role, full, from, to, true));
      const reference = fine.value ? stepsLength(from, fine.value, to) : null;
      const old = time(() => windowed(collision, role, from, to));
      routes[name] = { status: route.status, length: Number.isFinite(route.length) ? route.length : null, waypoints: route.waypoints.length,
        hierarchyMs: trials.map(t => t.ms), hierarchyMedianMs: median(trials.map(t => t.ms)),
        fineMs: fine.ms, fineLength: reference, stretch: reference && Number.isFinite(route.length) ? route.length / reference : null,
        windowedMs: old.ms, windowedFound: !!old.value, distance: Math.hypot(to.x - from.x, to.y - from.y) };
    }
    result.roles[role] = { doors, routes };
  }
  return result;

}

const lock = await acquireMachineLock('bench');
try {
  const out = process.argv[2] ?? 'test-results/navigation-420.json';
  const report = { revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), created: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, cpuCount: os.cpus().length, totalMemory: os.totalmem(),
    sourceHashes: Object.fromEntries(SOURCES.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), maps: [] };
  for (const size of LIVE_ZONE_SIZES) for (let seed = 1; seed <= SEEDS[zoneSizeName(size)]; seed++) {
    console.error(`Measuring ${zoneSizeName(size)} seed ${seed}`);
    report.maps.push(measureMap(size, seed));
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
} finally { lock.release(); }
