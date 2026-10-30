// How good are gladiators' straight-line portal corridors (#682)? For trips between live-map landmarks in different
// regions (hunter spawns, transit stations, the exit), compare a whole-map tile search with the corridor content-7
// walks: the portal route with crossings costed by straight lines, then a tile route for each stretch between
// crossings. The stretch sum is an upper bound on the walk, since the bot plans past the next crossing and can cut
// corners there. Also reports expansions, the portal query's time, and the measured tables' build time for one
// body, which is what prebaking measured edges would add to generation.
// node tools/navigation/corridor-report.mjs [output.json]   SIZES=12x6:3,24x12:2,36x18:2  TABLES=1 times measured tables
import { writeFileSync } from 'node:fs';
import { generateLiveMap, liveZoneSize } from '../../map/live.ts';
import { contentById } from '../../shared/simulation/content.ts';
import { prebuiltTiles } from '../../shared/simulation/bots.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { createKnowledgePlanner } from '../../shared/navigation/knowledge.ts';
import { createPortalPlanner, portalGraphOf, regionAt, regionTables } from '../../shared/navigation/portal-graph.ts';
import { meshReach } from '../../shared/navigation/mesh-level.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';

const SIZES = (process.env.SIZES ?? '12x6:3,24x12:2,36x18:2').split(',').map(entry => { const [size, seeds] = entry.split(':'); return { size, seeds: Number(seeds) }; });
const BUDGET = 400_000;
const straightReach = (from, targets) => targets.map(t => Math.hypot(t.x - from.x, t.y - from.y));
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };

await acquireMachineLock('bench');
const rows = [];
for (const { size, seeds } of SIZES) for (let seed = 1; seed <= seeds; seed++) {
  const [zoneWidth, zoneHeight] = size.split('x').map(Number), content = contentById('content-7');
  const generating = performance.now(), map = generateLiveMap(seed, content, liveZoneSize({ zoneWidth, zoneHeight })), generationMs = performance.now() - generating;
  for (const tiles of prebuiltTiles(map, content)) adoptPackedTiles(map, tiles);
  const graph = portalGraphOf(map), tiles = createKnowledgePlanner(map, 'gladiator'), portals = createPortalPlanner(graph, straightReach, 'straight');
  const gates = new Map(map.gates.map(g => [g.id, g]));
  const knowledge = { known: () => true, door: id => { const g = gates.get(id); return g && { open: g.open, locked: !!g.locked }; }, keys: 0, revision: 0 };
  const landmarks = [...map.hunterSpawns ?? [], ...map.stations, map.exit].map(({ x, y }) => ({ x, y }));
  const trips = [];
  for (const from of landmarks) for (const to of landmarks) if (from !== to && regionAt(graph, from) !== regionAt(graph, to)) trips.push([from, to]);
  let fullExpansions = 0, corridorExpansions = 0, queryMs = 0;
  const ratios = [], failures = { whole: 0, corridor: 0, portal: 0 };
  for (const [from, to] of trips) {
    const whole = tiles.route(knowledge, from, to, BUDGET);
    fullExpansions += whole.expansions;
    const started = performance.now(), corridor = portals.route(from, to);
    queryMs += performance.now() - started;
    if (corridor.status !== 'complete') { failures.portal++; continue; }
    let length = 0, at = from, ok = true;
    for (const point of corridor.waypoints) {
      const leg = tiles.route(knowledge, at, point, BUDGET);
      corridorExpansions += leg.expansions;
      if (leg.status !== 'complete') { ok = false; break; }
      length += leg.length; at = point;
    }
    if (!ok) { failures.corridor++; continue; }
    if (whole.status !== 'complete') { failures.whole++; continue; }
    ratios.push(length / whole.length);
  }
  let tablesMs = null;
  if (process.env.TABLES === '1') { const started = performance.now(); regionTables(graph, meshReach(map, 'gladiator', graph)); tablesMs = performance.now() - started; }
  const row = { size, seed, trips: trips.length, compared: ratios.length, failures, ratio: { median: median(ratios), p90: [...ratios].sort((a, b) => a - b)[Math.floor(0.9 * ratios.length)], max: Math.max(...ratios) },
    over10: ratios.filter(r => r > 1.1).length, expansions: { whole: fullExpansions, corridor: corridorExpansions }, queryMs: queryMs / Math.max(1, trips.length), tablesMs, generationMs };
  rows.push(row);
  console.log(`${size} seed ${seed}: ${row.compared}/${row.trips} trips, corridor/whole length median ${row.ratio.median.toFixed(3)}, p90 ${row.ratio.p90?.toFixed(3)}, max ${row.ratio.max.toFixed(3)},`
    + ` ${row.over10} over 10%; failures ${JSON.stringify(failures)}; query ${row.queryMs.toFixed(2)} ms${tablesMs === null ? '' : `; measured tables ${tablesMs.toFixed(0)} ms of ${generationMs.toFixed(0)} generation`}`);
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ node: process.version, rows }, null, 1));
