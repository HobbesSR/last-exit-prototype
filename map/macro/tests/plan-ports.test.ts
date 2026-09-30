/**
 * Perimeter ports and the macro reachability proof.
 *
 * The partitions here are hand made and small enough that every boundary run is
 * enumerable on paper, because the value of `findBoundaries` is entirely in
 * which segments it groups together: a pair of regions touching twice has to
 * come back as two boundaries or the loop it represents is invisible.
 *
 * Everything asserted below is a property of the plan graph. None of it is
 * evidence about laid-out geometry; micro conformance is what carries the
 * floors proved here into a built map.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PORT_OPTIONS,
  findBoundaries,
  planPorts,
  planPortsWithReport,
  proveReachability,
  type Boundary,
  type PartitionedRegion,
  type RouteRequirement,
} from "../src/plan/ports.ts";
import { admitsPassage, type RegionPlan } from "../src/plan/types.ts";
import type { SegmentRef } from "../src/micro/types.ts";

/** A region covering an inclusive cell rectangle. */
function rect(
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
): PartitionedRegion {
  const cells: number[] = [];
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) cells.push(y * width + x);
  return {
    id,
    type: "test",
    seed: 1,
    cells,
    bounds: [x0, y0, x1, y1],
    tier: 1,
    bonus: 0,
  };
}

/** A region from explicit cell coordinates, for shapes a rectangle cannot say. */
function shape(
  id: string,
  cells: Array<[number, number]>,
  width: number,
): PartitionedRegion {
  const indices = cells.map(([x, y]) => y * width + x).sort((a, b) => a - b);
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  return {
    id,
    type: "test",
    seed: 1,
    cells: indices,
    bounds: [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ],
    tier: 1,
    bonus: 0,
  };
}

/** `cols` x `rows` square regions of `size` cells, ids "r00".."rNN". */
function gridPartition(cols: number, rows: number, size: number) {
  const width = cols * size;
  const height = rows * size;
  const regions: PartitionedRegion[] = [];
  for (let row = 0; row < rows; row += 1)
    for (let col = 0; col < cols; col += 1) {
      const n = row * cols + col;
      regions.push(
        rect(
          `r${String(n).padStart(2, "0")}`,
          col * size,
          row * size,
          col * size + size - 1,
          row * size + size - 1,
          width,
        ),
      );
    }
  return { regions, width, height };
}

function key(segment: SegmentRef): string {
  return `${segment.vertical ? "v" : "h"}${segment.line}.${segment.offset}`;
}

function run(segments: readonly SegmentRef[]): string[] {
  return segments.map(key);
}

function between(
  boundaries: readonly Boundary[],
  a: string,
  b: string | null,
): Boundary[] {
  const pair = (x: Boundary) =>
    (x.a === a && x.b === b) || (x.a === b && x.b === a);
  return boundaries.filter(pair);
}

/** Every segment the region shares with anything that is not itself. */
function perimeterOf(region: PartitionedRegion, width: number): Set<string> {
  const own = new Set(region.cells);
  const out = new Set<string>();
  for (const cell of region.cells) {
    const x = cell % width;
    const y = (cell - x) / width;
    const steps: Array<[number, number, SegmentRef]> = [
      [x - 1, y, { vertical: true, line: x, offset: y }],
      [x + 1, y, { vertical: true, line: x + 1, offset: y }],
      [x, y - 1, { vertical: false, line: y, offset: x }],
      [x, y + 1, { vertical: false, line: y + 1, offset: x }],
    ];
    for (const [nx, ny, segment] of steps) {
      if (nx >= 0 && ny >= 0 && own.has(ny * width + nx)) continue;
      out.add(key(segment));
    }
  }
  return out;
}

// A 2x2 grid of 2x2 regions on a 4x4 map. Four interior boundaries, and two
// map-edge runs per region.
const QUAD_WIDTH = 4;
const QUAD = [
  rect("A", 0, 0, 1, 1, QUAD_WIDTH),
  rect("B", 2, 0, 3, 1, QUAD_WIDTH),
  rect("C", 0, 2, 1, 3, QUAD_WIDTH),
  rect("D", 2, 2, 3, 3, QUAD_WIDTH),
];
const QUAD_ROUTES: RouteRequirement = {
  spawnRegion: "A",
  hunterSpawnRegion: "B",
  exitRegions: ["D"],
};

test("a 2x2 grid of regions gives exactly the four interior runs", () => {
  const boundaries = findBoundaries(QUAD, QUAD_WIDTH, QUAD_WIDTH);
  const interior = boundaries.filter((b) => b.b !== null);
  assert.equal(interior.length, 4);
  assert.deepEqual(run(between(interior, "A", "B")[0]!.segments), [
    "v2.0",
    "v2.1",
  ]);
  assert.deepEqual(run(between(interior, "A", "C")[0]!.segments), [
    "h2.0",
    "h2.1",
  ]);
  assert.deepEqual(run(between(interior, "B", "D")[0]!.segments), [
    "h2.2",
    "h2.3",
  ]);
  assert.deepEqual(run(between(interior, "C", "D")[0]!.segments), [
    "v2.2",
    "v2.3",
  ]);
  // A and D touch only at a corner, which is not a segment and not a boundary.
  assert.equal(between(interior, "A", "D").length, 0);
});

test("the map edge is its own run per region side", () => {
  const boundaries = findBoundaries(QUAD, QUAD_WIDTH, QUAD_WIDTH);
  const edge = boundaries.filter((b) => b.b === null);
  assert.equal(edge.length, 8);
  const forA = edge.filter((b) => b.a === "A").map((b) => run(b.segments));
  assert.deepEqual(forA, [
    ["h0.0", "h0.1"],
    ["v0.0", "v0.1"],
  ]);
});

test("an L-shaped contact is two runs, not one bent one", () => {
  // A is an L around B in the corner: they meet along one vertical segment and
  // one horizontal one, which are not collinear and so are separate boundaries.
  const width = 2;
  const regions = [
    shape(
      "A",
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      width,
    ),
    shape("B", [[1, 1]], width),
  ];
  const interior = findBoundaries(regions, width, 2).filter(
    (b) => b.b !== null,
  );
  assert.equal(interior.length, 2);
  assert.deepEqual(
    interior.map((b) => run(b.segments)).sort(),
    [["h1.1"], ["v1.1"]].sort(),
  );
});

test("two regions touching in two places give two boundaries", () => {
  // A fills the left half; B is the right half except for its middle row, which
  // C occupies. A and B therefore meet above and below C, on the same grid line
  // but with a cell of gap: a loop, and it only reads as one if the gap splits
  // the run.
  const width = 4;
  const regions = [
    rect("A", 0, 0, 1, 2, width),
    shape(
      "B",
      [
        [2, 0],
        [3, 0],
        [2, 2],
        [3, 2],
      ],
      width,
    ),
    rect("C", 2, 1, 3, 1, width),
  ];
  const interior = findBoundaries(regions, width, 3).filter(
    (b) => b.b !== null,
  );
  const ab = between(interior, "A", "B");
  assert.equal(ab.length, 2);
  assert.deepEqual(
    ab.map((b) => run(b.segments)),
    [["v2.0"], ["v2.2"]],
  );
  assert.deepEqual(
    between(interior, "A", "C").map((b) => run(b.segments)),
    [["v2.1"]],
  );
  // B and C meet on two different horizontal lines: also two boundaries.
  assert.equal(between(interior, "B", "C").length, 2);
  // Ids are derived from the pair and the run's own first segment, so the two
  // A/B boundaries are distinguishable and stable.
  assert.deepEqual(
    ab.map((b) => b.id),
    ["A~B~v2.0", "A~B~v2.2"],
  );
});

test("boundary order does not depend on the order regions arrive in", () => {
  const forward = findBoundaries(QUAD, QUAD_WIDTH, QUAD_WIDTH);
  const reversed = findBoundaries([...QUAD].reverse(), QUAD_WIDTH, QUAD_WIDTH);
  assert.deepEqual(reversed, forward);
});

test("mirrored ports agree on id, segments and both bands", () => {
  const { regions, width, height } = gridPartition(6, 5, 3);
  const planned = planPorts("mirror-seed", regions, width, height, {
    spawnRegion: "r00",
    hunterSpawnRegion: "r29",
    exitRegions: ["r05", "r24"],
  });
  const byId = new Map(planned.map((region) => [region.id, region]));
  let pairs = 0;
  for (const region of planned)
    for (const port of region.ports) {
      if (port.neighbour === null) continue;
      const far = byId.get(port.neighbour);
      assert.ok(far, `port names an unknown neighbour ${port.neighbour}`);
      const mirror = far.ports.find((other) => other.id === port.id);
      assert.ok(mirror, `no mirrored port ${port.id} on ${port.neighbour}`);
      assert.equal(mirror.neighbour, region.id);
      assert.equal(mirror.required, port.required);
      assert.equal(mirror.allowed, port.allowed);
      assert.deepEqual(run(mirror.segments), run(port.segments));
      pairs += 1;
    }
  assert.equal(
    pairs,
    98,
    `expected 49 interior boundaries seen twice, saw ${pairs}`,
  );
});

test("every perimeter segment of every region is covered by exactly one port", () => {
  const cases: Array<{
    regions: PartitionedRegion[];
    width: number;
    height: number;
    routes: RouteRequirement;
  }> = [
    {
      regions: QUAD,
      width: QUAD_WIDTH,
      height: QUAD_WIDTH,
      routes: QUAD_ROUTES,
    },
    {
      ...gridPartition(4, 4, 3),
      routes: {
        spawnRegion: "r00",
        hunterSpawnRegion: "r15",
        exitRegions: ["r12"],
      },
    },
  ];
  for (const { regions, width, height, routes } of cases) {
    const planned = planPorts("coverage", regions, width, height, routes);
    for (const region of planned) {
      const expected = perimeterOf(region, width);
      const seen = new Map<string, number>();
      for (const port of region.ports)
        for (const segment of port.segments)
          seen.set(key(segment), (seen.get(key(segment)) ?? 0) + 1);
      for (const [segment, count] of seen)
        assert.equal(count, 1, `${region.id} covers ${segment} ${count} times`);
      assert.deepEqual(
        [...seen.keys()].sort(),
        [...expected].sort(),
        `${region.id} port coverage does not match its perimeter`,
      );
    }
  }
});

test("map-edge ports are sealed and name no neighbour", () => {
  const planned = planPorts("edges", QUAD, QUAD_WIDTH, QUAD_WIDTH, QUAD_ROUTES);
  const edges = planned.flatMap((region) =>
    region.ports.filter((port) => port.neighbour === null),
  );
  assert.equal(edges.length, 8);
  for (const port of edges) {
    assert.equal(port.required, "none");
    assert.equal(port.allowed, "none");
  }
});

test("loot is a placeholder the loot pass overwrites", () => {
  const planned = planPorts("loot", QUAD, QUAD_WIDTH, QUAD_WIDTH, QUAD_ROUTES);
  for (const region of planned)
    assert.deepEqual(region.loot, {
      budget: 0,
      tier: region.tier,
      density: 0,
    });
});

test("the spanning tree makes the plan prove out, with nothing upgraded", () => {
  const { regions, width, height } = gridPartition(5, 4, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r00",
    hunterSpawnRegion: "r19",
    exitRegions: ["r04", "r15"],
  };
  const report = planPortsWithReport("tree", regions, width, height, routes);
  assert.deepEqual(report.validation.errors, []);
  assert.equal(report.validation.valid, true);
  // The tree already satisfies every route, so repair never runs.
  assert.equal(report.upgrades, 0);
  // Tree boundaries are never capped and never sealed: some port on every
  // region has to carry a hunter floor, or the region is a hole in the tree.
  for (const region of report.regions)
    assert.ok(
      region.ports.some((port) => port.required === "hunter"),
      `${region.id} has no required hunter port`,
    );
});

test("sealing a tree boundary fails the proof and names the stranded region", () => {
  // With every chance at zero the only required boundaries are the tree, which
  // BFS from A builds as A-B, A-C, B-D. C's other boundary, C-D, is left with a
  // floor of "none", so sealing A-C strands C and nothing else.
  const planned = planPorts(
    "broken",
    QUAD,
    QUAD_WIDTH,
    QUAD_WIDTH,
    QUAD_ROUTES,
    {
      loopChance: 0,
      squeezeChance: 0,
      sealChance: 0,
    },
  );
  assert.equal(proveReachability(planned, QUAD_ROUTES).valid, true);

  const seal = (plan: RegionPlan[], id: string, sides: string[]) =>
    plan.map((region) => ({
      ...region,
      ports: region.ports.map((port) =>
        port.id === id && sides.includes(region.id)
          ? { ...port, required: "none" as const, allowed: "none" as const }
          : port,
      ),
    }));

  const bothSides = proveReachability(
    seal(planned, "A~C~h2.0", ["A", "C"]),
    QUAD_ROUTES,
  );
  assert.equal(bothSides.valid, false);
  assert.ok(
    bothSides.errors.some(
      (message) => message.includes('"C"') && message.includes("contestant"),
    ),
    `expected C to be named: ${bothSides.errors.join(" | ")}`,
  );
  assert.ok(
    bothSides.errors.every((message) => !message.includes('"D"')),
    `D is still reachable through B: ${bothSides.errors.join(" | ")}`,
  );

  // A one-sided seal is a contradiction micro could not satisfy, so the proof
  // reads the weaker side rather than the convenient one.
  assert.equal(
    proveReachability(seal(planned, "A~C~h2.0", ["A"]), QUAD_ROUTES).valid,
    false,
  );
});

test("proveReachability names a route whose regions are not in the plan", () => {
  const planned = planPorts(
    "routes",
    QUAD,
    QUAD_WIDTH,
    QUAD_WIDTH,
    QUAD_ROUTES,
  );
  const result = proveReachability(planned, {
    spawnRegion: "Z",
    hunterSpawnRegion: "B",
    exitRegions: ["D"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes('"Z"')));
});

test("a squeeze port admits a contestant and refuses a hunter", () => {
  const { regions, width, height } = gridPartition(5, 4, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r00",
    hunterSpawnRegion: "r19",
    exitRegions: ["r04"],
  };
  // Every boundary the tree does not need becomes a squeeze.
  const report = planPortsWithReport(
    "squeeze",
    regions,
    width,
    height,
    routes,
    {
      loopChance: 0,
      squeezeChance: 1,
      sealChance: 0,
    },
  );
  const squeezes = report.regions.flatMap((region) =>
    region.ports.filter((port) => port.required === "contestant"),
  );
  assert.ok(squeezes.length > 0, "expected the extra boundaries to be capped");
  for (const port of squeezes) {
    assert.equal(port.allowed, "contestant");
    assert.equal(admitsPassage(port.required, "contestant"), true);
    assert.equal(admitsPassage(port.required, "hunter"), false);
    assert.equal(admitsPassage(port.allowed, "hunter"), false);
  }
  // Capping is only safe because the tree is never capped.
  assert.equal(report.validation.valid, true);
  assert.equal(report.upgrades, 0);
});

test("sealing every optional boundary still leaves the tree standing", () => {
  const { regions, width, height } = gridPartition(5, 4, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r07",
    hunterSpawnRegion: "r19",
    exitRegions: ["r00", "r04"],
  };
  const report = planPortsWithReport("sealed", regions, width, height, routes, {
    loopChance: 0,
    squeezeChance: 0,
    sealChance: 1,
  });
  assert.deepEqual(report.validation.errors, []);
  assert.equal(report.upgrades, 0);
});

test("planning is deterministic in the seed", () => {
  const { regions, width, height } = gridPartition(4, 4, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r00",
    hunterSpawnRegion: "r15",
    exitRegions: ["r03"],
  };
  const once = planPorts("same", regions, width, height, routes);
  const twice = planPorts("same", regions, width, height, routes);
  assert.deepEqual(twice, once);
  // Shuffling the input must not move a single band, because nothing is drawn
  // from the order regions arrive in.
  const shuffled = planPorts(
    "same",
    [...regions].reverse(),
    width,
    height,
    routes,
  );
  const bandsOf = (plan: RegionPlan[]) =>
    plan
      .flatMap((region) => region.ports)
      .map((port) => `${port.id}:${port.required}/${port.allowed}`)
      .sort();
  assert.deepEqual(bandsOf(shuffled), bandsOf(once));
  const other = planPorts("different", regions, width, height, routes);
  assert.notDeepEqual(bandsOf(other), bandsOf(once));
});

test("a port id does not shift when an unrelated region changes", () => {
  const { regions, width, height } = gridPartition(4, 4, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r00",
    hunterSpawnRegion: "r15",
    exitRegions: ["r03"],
  };
  const before = planPorts("stable", regions, width, height, routes);
  // Rename a far corner. The ids around r00 are derived from their own pair and
  // their own first segment, so none of them may move.
  const renamed = regions.map((region) =>
    region.id === "r15" ? { ...region, id: "zz" } : region,
  );
  const after = planPorts("stable", renamed, width, height, routes);
  const idsAround = (plan: RegionPlan[]) =>
    plan
      .find((region) => region.id === "r00")!
      .ports.map((port) => port.id)
      .sort();
  assert.deepEqual(idsAround(after), idsAround(before));
});

test("the shipped defaults prove out across a seed sweep", () => {
  const { regions, width, height } = gridPartition(6, 5, 3);
  const routes: RouteRequirement = {
    spawnRegion: "r02",
    hunterSpawnRegion: "r27",
    exitRegions: ["r00", "r05", "r29"],
  };
  const SEEDS = 40;
  let loops = 0;
  let squeezes = 0;
  let seals = 0;
  for (let n = 0; n < SEEDS; n += 1) {
    const report = planPortsWithReport(
      `sweep-${n}`,
      regions,
      width,
      height,
      routes,
      DEFAULT_PORT_OPTIONS,
    );
    assert.deepEqual(
      report.validation.errors,
      [],
      `seed sweep-${n} did not prove out`,
    );
    assert.equal(report.upgrades, 0, `seed sweep-${n} needed repair`);
    // One side of each boundary, so the counts are boundaries not port sides.
    for (const region of report.regions)
      for (const port of region.ports) {
        if (port.neighbour === null || port.neighbour < region.id) continue;
        if (port.required === "contestant") squeezes += 1;
        else if (port.allowed === "none") seals += 1;
        else if (port.required === "hunter") loops += 1;
      }
  }
  // The mix has to actually happen: a planner that only ever ships the tree is
  // the maze this module exists to stop, and one that never seals is not using
  // the ceiling at all.
  assert.ok(loops > 0 && squeezes > 0 && seals > 0, {
    loops,
    squeezes,
    seals,
  } as unknown as string);
});

test("a partition that does not touch is reported, not silently repaired", () => {
  // Two regions with a cell of nobody's ground between them. No band on any
  // boundary can join them, and saying so is the whole job.
  const width = 3;
  const regions = [rect("A", 0, 0, 0, 0, width), rect("B", 2, 0, 2, 0, width)];
  const routes: RouteRequirement = {
    spawnRegion: "A",
    hunterSpawnRegion: "A",
    exitRegions: ["B"],
  };
  const report = planPortsWithReport("split", regions, width, 1, routes);
  assert.equal(report.validation.valid, false);
  assert.ok(
    report.validation.errors.some((message) => message.includes('"B"')),
  );
});
