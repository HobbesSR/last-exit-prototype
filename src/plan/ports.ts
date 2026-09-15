/**
 * Perimeter ports, and the reachability proof macro runs before anything is
 * built.
 *
 * This is the module `plan/types.ts` exists for. The legacy path in `core.ts`
 * cannot know whether a map is walkable until the whole map exists, so it
 * reserves a street network through finished geometry and repairs what micro
 * breaks. That costs a third of the map, and it is there only because macro has
 * no vocabulary for what it needs.
 *
 * Here macro states it. Every run of boundary a region shares with one
 * neighbour becomes a `PerimeterPort` carrying a floor (`required`: what must be
 * able to cross when micro is done) and a ceiling (`allowed`: what may). The
 * floors are chosen so the region graph -- a few hundred nodes -- is connected
 * for both bodies, and connectivity is then checked on that graph alone.
 *
 * What that check is, exactly: it is a proof about a graph, not about geometry.
 * It says the plan's own floors connect the regions the routes name. It becomes
 * a statement about a built map only because micro is separately required to
 * honour those floors, and `micro/conform.ts` is what establishes that. Nothing
 * here inspects a cell, and nothing here should be read as evidence that
 * laid-out geometry is walkable.
 *
 * When both halves hold there is no reserved corridor network to thread and
 * nothing to repair.
 */
import { createRng } from "../micro/rng.ts";
import type { Passage, PerimeterPort, SegmentRef } from "../micro/types.ts";
import type { ValidationResult } from "../types.ts";
import { PASSAGE_RANK, admitsPassage, type RegionPlan } from "./types.ts";

/**
 * A region as the partition pass leaves it: everything about a region except
 * the two things later passes decide. Ports are this module's output; loot
 * belongs to the loot pass.
 */
export type PartitionedRegion = Omit<RegionPlan, "ports" | "loot">;

/**
 * One maximal run of contiguous collinear segments separating two regions,
 * before anything has decided what may cross it.
 *
 * A pair of regions that touches in two places produces two boundaries, and
 * that separation is the point: the second one is a loop, and a map whose every
 * boundary is a tree edge is the maze this generator is trying to stop being.
 * Runs split on orientation and grid line as well as on gaps, so an L-shaped
 * contact is two boundaries rather than one bent one -- each independently
 * loopable, cappable and sealable.
 *
 * A run facing outside the map, or facing ground the partition left to no one,
 * carries `b: null`. Those are emitted too, so that every perimeter segment of
 * every region is covered by exactly one port and a builder can read where its
 * area stops instead of inferring it from a gap in the list.
 */
export interface Boundary {
  /** Stable in the two region ids and the run's own first segment. */
  id: string;
  /** The lexicographically earlier region id. */
  a: string;
  /** The other region, or null where the run faces outside the map. */
  b: string | null;
  /** Orientation and grid line the whole run lies on. */
  vertical: boolean;
  line: number;
  /** The run, ascending by offset. */
  segments: SegmentRef[];
}

export interface PortOptions {
  /** Chance a non-tree boundary becomes a second route (a loop). Default 0.35. */
  loopChance?: number;
  /** Chance a port is capped to contestant-only, making a squeeze. Default 0.15. */
  squeezeChance?: number;
  /** Chance a non-required boundary is sealed outright. Default 0.2. */
  sealChance?: number;
}

export interface RouteRequirement {
  spawnRegion: string;
  hunterSpawnRegion: string;
  exitRegions: string[];
}

/**
 * The shipped mix. Loops take the largest share because a pure spanning tree
 * makes every region a cul-de-sac; squeezes the smallest because a
 * contestant-only shortcut is meant to be a find rather than the usual case.
 */
export const DEFAULT_PORT_OPTIONS = Object.freeze({
  loopChance: 0.35,
  squeezeChance: 0.15,
  sealChance: 0.2,
});

interface Band {
  required: Passage;
  allowed: Passage;
}

/** The four bands a boundary can end up with. Copied on use, never shared. */
const SEALED: Band = { required: "none", allowed: "none" };
const OPEN: Band = { required: "hunter", allowed: "hunter" };
const SQUEEZE: Band = { required: "contestant", allowed: "contestant" };
const FREE: Band = { required: "none", allowed: "hunter" };

/**
 * What planning had to do to keep its promises, alongside the regions.
 *
 * `upgrades` counts boundaries the route repair raised because the spanning
 * tree did not already satisfy a route. It should be 0 on every plan this
 * module produces, and a caller watching it climb is watching the partition and
 * the route choice fight each other.
 */
export interface PortPlanReport {
  regions: RegionPlan[];
  upgrades: number;
  /** The proof over the finished plan. Invalid means repair could not fix it. */
  validation: ValidationResult;
}

function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Sort key making boundary order independent of the order regions arrived in. */
function boundaryOrder(x: Boundary, y: Boundary): number {
  return (
    compare(x.a, y.a) ||
    compare(x.b ?? "", y.b ?? "") ||
    Number(x.vertical) - Number(y.vertical) ||
    x.line - y.line ||
    x.segments[0]!.offset - y.segments[0]!.offset
  );
}

function segmentKey(segment: SegmentRef): string {
  return `${segment.vertical ? "v" : "h"}${segment.line}.${segment.offset}`;
}

/**
 * Split one pair's segments into maximal contiguous collinear runs. Segments on
 * different lines, or on the same line with a cell of gap between them, belong
 * to different boundaries.
 */
function runsOf(segments: Iterable<SegmentRef>): SegmentRef[][] {
  const byLine = new Map<string, SegmentRef[]>();
  for (const segment of segments) {
    const key = `${segment.vertical ? "v" : "h"}${segment.line}`;
    const list = byLine.get(key);
    if (list) list.push(segment);
    else byLine.set(key, [segment]);
  }
  const runs: SegmentRef[][] = [];
  for (const list of byLine.values()) {
    list.sort((p, q) => p.offset - q.offset);
    let run: SegmentRef[] = [];
    for (const segment of list) {
      if (run.length && segment.offset !== run[run.length - 1]!.offset + 1) {
        runs.push(run);
        run = [];
      }
      run.push(segment);
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

/** Every boundary run between two planned regions, before any is required. */
export function findBoundaries(
  regions: readonly PartitionedRegion[],
  width: number,
  height: number,
): Boundary[] {
  const owner = new Int32Array(Math.max(0, width * height)).fill(-1);
  regions.forEach((region, index) => {
    for (const cell of region.cells) {
      if (cell >= 0 && cell < owner.length) owner[cell] = index;
    }
  });

  // Keyed by the unordered pair, so a segment reached from both sides lands
  // once and the two sides cannot disagree about which run it is in.
  const groups = new Map<
    string,
    { a: string; b: string | null; segments: Map<string, SegmentRef> }
  >();
  const add = (a: string, b: string | null, segment: SegmentRef) => {
    const swap = b !== null && b < a;
    const lo = swap ? b : a;
    const hi = swap ? a : b;
    const key = JSON.stringify([lo, hi]);
    let group = groups.get(key);
    if (!group) {
      group = { a: lo, b: hi, segments: new Map() };
      groups.set(key, group);
    }
    group.segments.set(segmentKey(segment), segment);
  };

  for (const region of regions) {
    for (const cell of region.cells) {
      if (cell < 0 || cell >= owner.length) continue;
      const x = cell % width;
      const y = (cell - x) / width;
      // The four neighbours with the segment between, in the addressing
      // `core.searchRegions` walks: a vertical segment's `line` is the x of the
      // grid line and `offset` the row; a horizontal one's `line` is the y and
      // `offset` the column.
      const steps: Array<[number, number, SegmentRef]> = [
        [x - 1, y, { vertical: true, line: x, offset: y }],
        [x + 1, y, { vertical: true, line: x + 1, offset: y }],
        [x, y - 1, { vertical: false, line: y, offset: x }],
        [x, y + 1, { vertical: false, line: y + 1, offset: x }],
      ];
      for (const [nx, ny, segment] of steps) {
        // Off the map and on ground the partition gave to no one are the same
        // answer: there is no region across this segment.
        const off = nx < 0 || ny < 0 || nx >= width || ny >= height;
        const other = off ? -1 : owner[ny * width + nx]!;
        if (other >= 0 && regions[other]!.id === region.id) continue;
        add(region.id, other < 0 ? null : regions[other]!.id, segment);
      }
    }
  }

  const boundaries: Boundary[] = [];
  for (const group of groups.values()) {
    for (const run of runsOf(group.segments.values())) {
      const first = run[0]!;
      boundaries.push({
        // Derived from the pair and this run's own first segment, so adding,
        // removing or renaming an unrelated region never shifts this id.
        // "*" rather than "edge" for the map side, so no region id can spell
        // the same port id a sealed perimeter run would.
        id: `${group.a}~${group.b ?? "*"}~${segmentKey(first)}`,
        a: group.a,
        b: group.b,
        vertical: first.vertical,
        line: first.line,
        segments: run,
      });
    }
  }
  boundaries.sort(boundaryOrder);
  return boundaries;
}

type Adjacency = Map<string, Array<{ other: string; boundary: Boundary }>>;

/** Adjacency over the interior boundaries only; the map edge joins nothing. */
function adjacencyOf(boundaries: readonly Boundary[]): Adjacency {
  const adjacency: Adjacency = new Map();
  const link = (from: string, to: string, boundary: Boundary) => {
    const list = adjacency.get(from);
    if (list) list.push({ other: to, boundary });
    else adjacency.set(from, [{ other: to, boundary }]);
  };
  for (const boundary of boundaries) {
    if (boundary.b === null) continue;
    link(boundary.a, boundary.b, boundary);
    link(boundary.b, boundary.a, boundary);
  }
  return adjacency;
}

/**
 * A spanning tree over the region graph, rooted at the spawn.
 *
 * Breadth first over boundaries already in sorted order, so which boundary
 * carries the tree depends on the partition and on nothing else. A component
 * the root cannot see gets its own tree from its lowest region id: that cannot
 * make a disconnected partition connected, and pretending otherwise would hide
 * exactly the failure the proof exists to surface.
 */
function spanningTree(
  regionIds: readonly string[],
  adjacency: Adjacency,
  root: string,
): Set<string> {
  const tree = new Set<string>();
  const seen = new Set<string>();
  const roots = regionIds.includes(root)
    ? [root, ...regionIds.filter((id) => id !== root)]
    : [...regionIds];
  for (const start of roots) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      for (const edge of adjacency.get(queue[head]!) ?? []) {
        if (seen.has(edge.other)) continue;
        seen.add(edge.other);
        tree.add(edge.boundary.id);
        queue.push(edge.other);
      }
    }
  }
  return tree;
}

/**
 * Cheapest route from `from` to `to` for `body`, counting a boundary whose
 * floor already admits the body as free. Dijkstra with a linear scan for the
 * nearest unsettled region: a few hundred nodes, run only when the tree has
 * already failed, and obviously correct.
 *
 * Returns the boundaries that would have to be raised, or null when no amount
 * of raising helps because the two regions never touch.
 */
function repairPath(
  from: string,
  to: string,
  body: Passage,
  adjacency: Adjacency,
  bands: Map<string, Band>,
): Boundary[] | null {
  if (from === to) return [];
  const dist = new Map<string, number>([[from, 0]]);
  const via = new Map<string, Boundary>();
  const settled = new Set<string>();
  for (;;) {
    let at: string | null = null;
    let best = Infinity;
    for (const [id, cost] of dist) {
      if (settled.has(id) || cost >= best) continue;
      at = id;
      best = cost;
    }
    if (at === null) return null;
    if (at === to) break;
    settled.add(at);
    for (const edge of adjacency.get(at) ?? []) {
      const band = bands.get(edge.boundary.id)!;
      const next = best + (admitsPassage(band.required, body) ? 0 : 1);
      const known = dist.get(edge.other);
      if (known !== undefined && known <= next) continue;
      dist.set(edge.other, next);
      via.set(edge.other, edge.boundary);
    }
  }
  const path: Boundary[] = [];
  for (let at = to; at !== from;) {
    const boundary = via.get(at)!;
    if (!admitsPassage(bands.get(boundary.id)!.required, body))
      path.push(boundary);
    at = boundary.a === at ? boundary.b! : boundary.a;
  }
  return path;
}

/** The ports one region declares, from the bands decided over its boundaries. */
function portsFor(
  id: string,
  boundaries: readonly Boundary[],
  bands: Map<string, Band>,
): PerimeterPort[] {
  const ports: PerimeterPort[] = [];
  for (const boundary of boundaries) {
    if (boundary.a !== id && boundary.b !== id) continue;
    const band = bands.get(boundary.id)!;
    ports.push({
      // Both sides of a boundary carry the same id, the same segments and the
      // same band, because they are one boundary seen twice. A disagreement
      // would be a contradiction micro could not satisfy from both regions at
      // once, so there is only ever one band to read.
      id: boundary.id,
      neighbour:
        boundary.b === null
          ? null
          : boundary.a === id
            ? boundary.b
            : boundary.a,
      segments: boundary.segments.map((segment) => ({ ...segment })),
      required: band.required,
      allowed: band.allowed,
    });
  }
  return ports;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Decide the passage band on every boundary so the region graph is connected
 * for both bodies, then hand each region its own ports.
 *
 * The `loot` on every returned region is a placeholder -- zero budget, zero
 * density, the region's own tier -- because loot policy belongs to the loot
 * pass, which overwrites this wholesale. Nothing here is a loot opinion.
 */
export function planPorts(
  seed: string,
  regions: readonly PartitionedRegion[],
  width: number,
  height: number,
  routes: RouteRequirement,
  options?: PortOptions,
): RegionPlan[] {
  return planPortsWithReport(seed, regions, width, height, routes, options)
    .regions;
}

/**
 * `planPorts` with the numbers that separate a healthy plan from one that only
 * just worked: how many boundaries route repair had to raise, and whether the
 * finished plan proves out at all. `planPorts` discards neither silently -- it
 * returns the part most callers want.
 */
export function planPortsWithReport(
  seed: string,
  regions: readonly PartitionedRegion[],
  width: number,
  height: number,
  routes: RouteRequirement,
  options?: PortOptions,
): PortPlanReport {
  const loopChance = clamp01(
    options?.loopChance ?? DEFAULT_PORT_OPTIONS.loopChance,
  );
  const squeezeChance = clamp01(
    options?.squeezeChance ?? DEFAULT_PORT_OPTIONS.squeezeChance,
  );
  const sealChance = clamp01(
    options?.sealChance ?? DEFAULT_PORT_OPTIONS.sealChance,
  );

  const boundaries = findBoundaries(regions, width, height);
  const adjacency = adjacencyOf(boundaries);
  const regionIds = regions.map((region) => region.id).sort(compare);
  const tree = spanningTree(regionIds, adjacency, routes.spawnRegion);

  // One named stream per boundary, so adding a boundary elsewhere on the map
  // cannot re-roll this one. That independence is what `micro/rng.ts` is for.
  const rng = createRng(seed).stream("plan/ports");
  const bands = new Map<string, Band>();
  for (const boundary of boundaries) {
    if (boundary.b === null) {
      // The map edge is sealed, and the port is emitted anyway: a builder reads
      // it as where its area ends.
      bands.set(boundary.id, { ...SEALED });
      continue;
    }
    if (tree.has(boundary.id)) {
      // The tree is the guarantee. It is never capped and never sealed, and a
      // hunter floor on every tree boundary puts every region in reach of both
      // bodies, since a hunter floor admits a contestant too.
      bands.set(boundary.id, { ...OPEN });
      continue;
    }
    // One draw against cumulative shares, so the three categories cannot
    // interact and a chance of zero costs nothing. Shares summing past 1 starve
    // the tail, which is the honest reading of asking for more than all of it.
    const roll = rng.stream(boundary.id).next();
    if (roll < loopChance) bands.set(boundary.id, { ...OPEN });
    else if (roll < loopChance + squeezeChance)
      bands.set(boundary.id, { ...SQUEEZE });
    else if (roll < loopChance + squeezeChance + sealChance)
      bands.set(boundary.id, { ...SEALED });
    else bands.set(boundary.id, { ...FREE });
  }

  const view = () =>
    regionIds.map((id) => ({ id, ports: portsFor(id, boundaries, bands) }));

  // The tree should already satisfy every route. Assert that rather than assume
  // it, and repair deterministically when the assertion turns out to be wrong.
  let validation = proveReachability(view(), routes);
  let upgrades = 0;
  if (!validation.valid) {
    const raise = (from: string, to: string, body: Passage) => {
      for (const boundary of repairPath(from, to, body, adjacency, bands) ??
        []) {
        bands.set(boundary.id, { ...OPEN });
        upgrades += 1;
      }
    };
    // Routes first, then every region, in sorted order: the repair reads the
    // same on every run, and the exits get the cheapest paths.
    for (const exit of routes.exitRegions) {
      raise(routes.spawnRegion, exit, "contestant");
      raise(routes.hunterSpawnRegion, exit, "hunter");
    }
    for (const id of regionIds) {
      raise(routes.spawnRegion, id, "contestant");
      raise(routes.hunterSpawnRegion, id, "hunter");
    }
    validation = proveReachability(view(), routes);
  }

  const planned = regions.map((region) => ({
    ...region,
    ports: portsFor(region.id, boundaries, bands),
    // Placeholder. The loot pass overwrites this, and this module has no view
    // on what a region owes.
    loot: { budget: 0, tier: region.tier, density: 0 },
  }));
  return { regions: planned, upgrades, validation };
}

/**
 * Does the plan's own contract guarantee the routes it promises?
 *
 * Only `required` is read. The floors are the part micro may not take away, so
 * they are the only part a proof may rest on; `allowed` is a ceiling on what
 * micro may add and promises nothing will be there.
 *
 * A boundary counts as passable when both of its declarations admit the body.
 * Mirrored ports agree by construction, so on a planned map that is the same as
 * reading either side; on a hand-edited one it is the difference between
 * catching a contradiction and walking through it.
 *
 * This proves a property of a graph. It becomes a claim about a built map only
 * because micro is separately required to honour the floors it reads here, and
 * it is never on its own evidence that geometry is walkable.
 */
export function proveReachability(
  regions: readonly Pick<RegionPlan, "id" | "ports">[],
  routes: RouteRequirement,
): ValidationResult {
  const errors: string[] = [];
  const known = new Set(regions.map((region) => region.id));
  const missing = (label: string, id: string) => {
    if (known.has(id)) return false;
    errors.push(`${label} "${id}" is not a region in this plan`);
    return true;
  };

  // A port id names one boundary, so the entries sharing an id are its two
  // sides. The floor that counts is the weaker of them.
  const floors = new Map<string, { pair: Set<string>; rank: number }>();
  for (const region of regions) {
    for (const port of region.ports) {
      if (port.neighbour === null) continue;
      const rank = PASSAGE_RANK[port.required];
      const entry = floors.get(port.id);
      if (entry) {
        entry.pair.add(region.id).add(port.neighbour);
        entry.rank = Math.min(entry.rank, rank);
      } else {
        floors.set(port.id, {
          pair: new Set([region.id, port.neighbour]),
          rank,
        });
      }
    }
  }
  const graph = new Map<string, Map<string, number>>();
  const link = (x: string, y: string, rank: number) => {
    let row = graph.get(x);
    if (!row) graph.set(x, (row = new Map()));
    // Two regions touching twice keep the better of the two floors.
    row.set(y, Math.max(row.get(y) ?? 0, rank));
  };
  for (const { pair, rank } of floors.values()) {
    const [from, to] = [...pair];
    if (from === undefined || to === undefined || from === to) continue;
    link(from, to, rank);
    link(to, from, rank);
  }

  const reach = (start: string, body: Passage): Set<string> => {
    const want = PASSAGE_RANK[body];
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      for (const [other, rank] of graph.get(queue[head]!) ?? []) {
        if (rank < want || seen.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    return seen;
  };

  const badSpawn = missing("spawn region", routes.spawnRegion);
  const badHunter = missing("hunter spawn region", routes.hunterSpawnRegion);
  for (const exit of routes.exitRegions) missing("exit region", exit);
  // Without a source there is nothing left to say that is not noise.
  if (badSpawn || badHunter) return { valid: false, errors };

  const byContestant = reach(routes.spawnRegion, "contestant");
  const byHunter = reach(routes.hunterSpawnRegion, "hunter");
  for (const exit of routes.exitRegions) {
    if (!known.has(exit)) continue;
    if (!byContestant.has(exit))
      errors.push(
        `no contestant route from spawn region "${routes.spawnRegion}" to exit region "${exit}": every path crosses a port whose required passage is below "contestant"`,
      );
    if (!byHunter.has(exit))
      errors.push(
        `no hunter route from hunter spawn region "${routes.hunterSpawnRegion}" to exit region "${exit}": every path crosses a port whose required passage is below "hunter"`,
      );
  }
  for (const region of regions) {
    if (!byContestant.has(region.id))
      errors.push(
        `region "${region.id}" is not contestant-reachable from spawn region "${routes.spawnRegion}"`,
      );
    if (!byHunter.has(region.id))
      errors.push(
        `region "${region.id}" is not hunter-reachable from hunter spawn region "${routes.hunterSpawnRegion}"`,
      );
  }
  return { valid: errors.length === 0, errors };
}
